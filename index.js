const shortid = require("shortid");
const scripto = require('redis-scripto');
const path = require('path');

class StreamChannelBroker {
    #scriptingEngine;

    constructor(redisClient, channelName) {
        this._redisClient = redisClient;
        this._destroying = false;
        this._channelName = channelName;
        this._activeSubscriptions = new Map();
        this._destroyingCheckWrapper = this._destroyingCheckWrapper.bind(this);
        this.publish = this._destroyingCheckWrapper(this.publish.bind(this));
        this._subscribe = this._destroyingCheckWrapper(this._subscribe.bind(this));
        this.joinConsumerGroup = this._destroyingCheckWrapper(this.joinConsumerGroup.bind(this));
        this.memoryFootprint = this._destroyingCheckWrapper(this.memoryFootprint.bind(this));
        this.destroy = this._destroyingCheckWrapper(this.destroy.bind(this));
        this._transformResponseToMessage = this._transformResponseToMessage.bind(this);
        this._acknowledgeMessage = this._destroyingCheckWrapper(this._acknowledgeMessage.bind(this));
        this._unsubscribe = this._destroyingCheckWrapper(this._unsubscribe.bind(this), false);
        this._groupPendingSummary = this._destroyingCheckWrapper(this._groupPendingSummary.bind(this), false);
        this.#scriptingEngine = new scripto(this._redisClient);
        this.#scriptingEngine.loadFromDir(path.resolve(path.dirname(__filename), 'lua'));
        this.#scriptingEngine.runLuaScriptAsync = async (scriptName, keys, args) => new Promise((resolve, reject) => this.#scriptingEngine.run(scriptName, keys, args, function (err, result) {
            if (err != undefined) {
                reject(err);
                return;
            }
            resolve(result)
        }));
        this.#scriptingEngine.runLuaScriptAsync.bind(this.#scriptingEngine);
    }

    _destroyingCheckWrapper(fn, async = true) {

        if (async === true) {
            return async (...theArgs) => {
                if (this._destroying === true) {
                    throw new Error(`Connection is closed to the server, Object under destruction.`);
                }
                return await fn(...theArgs);
            };
        }
        else {
            return (...theArgs) => {
                if (this._destroying === true) {
                    throw new Error(`Connection is closed to the server, Object under destruction.`);
                }
                return fn(...theArgs);
            };
        }
    }

    async _subscribe(groupName, consumerName, handler, pollSpan = 1000, payloadsToFetch = 2, subscriptionHandle = shortid.generate()) {
        const intervalHandle = setTimeout(async () => {
            try {
                const messages = await this._redisClient.xreadgroup("GROUP", groupName, consumerName, "COUNT", payloadsToFetch, "STREAMS", this._channelName, ">");
                if (messages !== null) {
                    let streamPayloads = this._transformResponseToMessage(messages, groupName);
                    await handler(streamPayloads);
                }
            }
            finally {
                if (this._destroying === false && this._unsubscribe(subscriptionHandle)) {
                    await this._subscribe(groupName, consumerName, handler, pollSpan, payloadsToFetch, subscriptionHandle);
                }
            }
        }, pollSpan);
        let subscriptions = this._activeSubscriptions.get(subscriptionHandle) || [];
        subscriptions.push(intervalHandle);
        this._activeSubscriptions.set(subscriptionHandle, subscriptions);
        return subscriptionHandle;
    }

    _unsubscribe(subscriptionHandle) {
        if (this._activeSubscriptions.has(subscriptionHandle)) {
            this._activeSubscriptions.get(subscriptionHandle).map(interval => clearInterval(interval));
            this._activeSubscriptions.delete(subscriptionHandle);
            return true;
        }
        else {
            return false;
        }
    }

    async _acknowledgeMessage(groupName, messageId, dropMessage = false) {
        let result;
        if (dropMessage === false) {
            result = await this._redisClient.xack(this._channelName, groupName, messageId);
        } else {
            result = await this._redisClient.multi()
                .xack(this._channelName, groupName, messageId)
                .xdel(this._channelName, messageId)
                .exec();
        }
        return result === 1;
    }

    _transformResponseToMessage(responses, groupName) {
        let payloads = [];
        for (let responseIdx = 0; responseIdx < responses.length; responseIdx++) {
            let streamName = responses[responseIdx][0];
            for (let messageIdIdx = 0; messageIdIdx < responses[responseIdx][1].length; messageIdIdx++) {
                let messageId = responses[responseIdx][1][messageIdIdx][0];
                let payload = { "channel": streamName, "id": messageId, payload: {} };
                payload["markAsRead"] = async (dropMessage) => await this._acknowledgeMessage(groupName, messageId, dropMessage);
                for (let propertyIdx = 0; propertyIdx < responses[responseIdx][1][messageIdIdx][1].length;) {
                    payload.payload[responses[responseIdx][1][messageIdIdx][1][propertyIdx]] = responses[responseIdx][1][messageIdIdx][1][propertyIdx + 1];
                    propertyIdx += 2;
                }
                payloads.push(payload);
            }
        }
        return payloads;
    }

    async _groupPendingSummary(groupName) {
        let result = await this._redisClient.xpending(this._channelName, groupName);
        let summary = { "total": result[0], "firstId": result[1], "lastId": result[2], "consumerStats": {} };
        summary.consumerStats = result[3] === null ? {} : result[3].reduce((acc, e) => {
            acc[e[0]] = e[1];
            return acc;
        }, {});
        return summary;
    }

    async joinConsumerGroup(groupName, readFrom = '$') {
        await this.#scriptingEngine.runLuaScriptAsync("create-group", [this._channelName], [groupName, readFrom]);
        return {
            "name": groupName,
            "readFrom": readFrom,
            "subscribe": async (...theArgs) => await this._subscribe(groupName, ...theArgs),
            "unsubscribe": this._unsubscribe,
            "pendingSummary": async () => await this._groupPendingSummary(groupName)
        }
    }

    async publish(payload, maximumApproximateMessages = 100) {
        let keyValuePairs = [];
        const payloadType = typeof payload;
        switch (payloadType) {
            case "object":
                for (const [key, value] of Object.entries(payload)) {
                    if ((value !== null && value !== undefined) && (typeof value === "string" || value instanceof String)) {
                        keyValuePairs.push(key);
                        keyValuePairs.push(value);
                    }
                    else {
                        throw new Error(`Data type of property ${key} is not supported.`);
                    }
                }
                break;
            default:
                throw new Error(`Payload of type ${payloadType} is not supported.`);
        }

        if (keyValuePairs.length === 0) {
            throw new Error(`Payload cannot be empty.`);
        }
        if (maximumApproximateMessages < 0) {
            return await this._redisClient.xadd(this._channelName, '*', ...keyValuePairs);
        }
        else {
            return await this._redisClient.xadd(this._channelName, 'MAXLEN', '~', maximumApproximateMessages, '*', ...keyValuePairs);
        }
    }

    async memoryFootprint() {
        return await this._redisClient.memory("usage", this._channelName, "samples", 0);
    }

    async destroy() {
        this._destroying = true;
        let result = Array.from(this._activeSubscriptions.keys).reduce(((pre, handle) => this._unsubscribe(handle) & pre), true);
        return result;
    }

}

exports.StreamChannelBroker = StreamChannelBroker;