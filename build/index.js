// src/chatgpt-api.ts
import Keyv from "keyv";
import pTimeout from "p-timeout";
import QuickLRU from "quick-lru";
import { v4 as uuidv4 } from "uuid";

// src/tokenizer.ts
import { getEncoding } from "js-tiktoken";
var tokenizer = getEncoding("cl100k_base");
function encode(input) {
  return new Uint32Array(tokenizer.encode(input));
}

// src/types.ts
var ChatGPTError = class extends Error {
};
var openai;
((openai2) => {
})(openai || (openai = {}));

// src/fetch.ts
var fetch2 = globalThis.fetch;

// src/fetch-sse.ts
import { createParser } from "eventsource-parser";

// src/stream-async-iterable.ts
async function* streamAsyncIterable(stream) {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        return;
      }
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

// src/fetch-sse.ts
async function fetchSSE(url, options, fetch3 = fetch2) {
  const { onMessage, onError, ...fetchOptions } = options;
  const res = await fetch3(url, fetchOptions);
  if (!res.ok) {
    let reason;
    try {
      reason = await res.text();
    } catch (err) {
      reason = res.statusText;
    }
    const msg = `ChatGPT error ${res.status}: ${reason}`;
    const error = new ChatGPTError(msg, { cause: res });
    error.statusCode = res.status;
    error.statusText = res.statusText;
    throw error;
  }
  const parser = createParser((event) => {
    if (event.type === "event") {
      onMessage(event.data);
    }
  });
  const feed = (chunk) => {
    var _a;
    let response = null;
    try {
      response = JSON.parse(chunk);
    } catch {
    }
    if (((_a = response == null ? void 0 : response.detail) == null ? void 0 : _a.type) === "invalid_request_error") {
      const msg = `ChatGPT error ${response.detail.message}: ${response.detail.code} (${response.detail.type})`;
      const error = new ChatGPTError(msg, { cause: response });
      error.statusCode = response.detail.code;
      error.statusText = response.detail.message;
      if (onError) {
        onError(error);
      } else {
        console.error(error);
      }
      return;
    }
    parser.feed(chunk);
  };
  if (!res.body.getReader) {
    const body = res.body;
    if (!body.on || !body.read) {
      throw new ChatGPTError('unsupported "fetch" implementation');
    }
    body.on("readable", () => {
      let chunk;
      while (null !== (chunk = body.read())) {
        feed(chunk.toString());
      }
    });
  } else {
    for await (const chunk of streamAsyncIterable(res.body)) {
      const str = new TextDecoder().decode(chunk);
      feed(str);
    }
  }
}

// src/chatgpt-api.ts
var CHATGPT_MODEL = "gpt-3.5-turbo";
var USER_LABEL_DEFAULT = "User";
var ASSISTANT_LABEL_DEFAULT = "ChatGPT";
var ChatGPTAPI = class {
  /**
   * Creates a new client wrapper around OpenAI's chat completion API, mimicing the official ChatGPT webapp's functionality as closely as possible.
   *
   * @param apiKey - OpenAI API key (required).
   * @param apiOrg - Optional OpenAI API organization (optional).
   * @param apiBaseUrl - Optional override for the OpenAI API base URL.
   * @param debug - Optional enables logging debugging info to stdout.
   * @param completionParams - Param overrides to send to the [OpenAI chat completion API](https://platform.openai.com/docs/api-reference/chat/create). Options like `temperature` and `presence_penalty` can be tweaked to change the personality of the assistant.
   * @param maxModelTokens - Optional override for the maximum number of tokens allowed by the model's context. Defaults to 4096.
   * @param maxResponseTokens - Optional override for the minimum number of tokens allowed for the model's response. Defaults to 1000.
   * @param messageStore - Optional [Keyv](https://github.com/jaredwray/keyv) store to persist chat messages to. If not provided, messages will be lost when the process exits.
   * @param getMessageById - Optional function to retrieve a message by its ID. If not provided, the default implementation will be used (using an in-memory `messageStore`).
   * @param upsertMessage - Optional function to insert or update a message. If not provided, the default implementation will be used (using an in-memory `messageStore`).
   * @param fetch - Optional override for the `fetch` implementation to use. Defaults to the global `fetch` function.
   */
  constructor(opts) {
    const {
      apiKey,
      apiOrg,
      apiBaseUrl = "https://api.openai.com/v1",
      debug = false,
      messageStore,
      completionParams,
      systemMessage,
      maxModelTokens = 4e3,
      maxResponseTokens = 1e3,
      getMessageById,
      upsertMessage,
      fetch: fetch3 = fetch2
    } = opts;
    this._apiKey = apiKey;
    this._apiOrg = apiOrg;
    this._apiBaseUrl = apiBaseUrl;
    this._debug = !!debug;
    this._fetch = fetch3;
    this._completionParams = {
      model: CHATGPT_MODEL,
      temperature: 0.8,
      top_p: 1,
      presence_penalty: 1,
      ...completionParams
    };
    this._systemMessage = systemMessage;
    if (this._systemMessage === void 0) {
      const currentDate = (/* @__PURE__ */ new Date()).toISOString().split("T")[0];
      this._systemMessage = `You are ChatGPT, a large language model trained by OpenAI. Answer as concisely as possible.
Knowledge cutoff: 2021-09-01
Current date: ${currentDate}`;
    }
    this._maxModelTokens = maxModelTokens;
    this._maxResponseTokens = maxResponseTokens;
    this._getMessageById = getMessageById ?? this._defaultGetMessageById;
    this._upsertMessage = upsertMessage ?? this._defaultUpsertMessage;
    if (messageStore) {
      this._messageStore = messageStore;
    } else {
      this._messageStore = new Keyv({
        store: new QuickLRU({ maxSize: 1e4 })
      });
    }
    if (!this._apiKey) {
      throw new Error("OpenAI missing required apiKey");
    }
    if (!this._fetch) {
      throw new Error("Invalid environment; fetch is not defined");
    }
    if (typeof this._fetch !== "function") {
      throw new Error('Invalid "fetch" is not a function');
    }
  }
  /**
   * Sends a message to the OpenAI chat completions endpoint, waits for the response
   * to resolve, and returns the response.
   *
   * If you want your response to have historical context, you must provide a valid `parentMessageId`.
   *
   * If you want to receive a stream of partial responses, use `opts.onProgress`.
   *
   * Set `debug: true` in the `ChatGPTAPI` constructor to log more info on the full prompt sent to the OpenAI chat completions API. You can override the `systemMessage` in `opts` to customize the assistant's instructions.
   *
   * @param message - The prompt message to send
   * @param opts.parentMessageId - Optional ID of the previous message in the conversation (defaults to `undefined`)
   * @param opts.conversationId - Optional ID of the conversation (defaults to `undefined`)
   * @param opts.messageId - Optional ID of the message to send (defaults to a random UUID)
   * @param opts.systemMessage - Optional override for the chat "system message" which acts as instructions to the model (defaults to the ChatGPT system message)
   * @param opts.timeoutMs - Optional timeout in milliseconds (defaults to no timeout)
   * @param opts.onProgress - Optional callback which will be invoked every time the partial response is updated
   * @param opts.abortSignal - Optional callback used to abort the underlying `fetch` call using an [AbortController](https://developer.mozilla.org/en-US/docs/Web/API/AbortController)
   * @param completionParams - Optional overrides to send to the [OpenAI chat completion API](https://platform.openai.com/docs/api-reference/chat/create). Options like `temperature` and `presence_penalty` can be tweaked to change the personality of the assistant.
   *
   * @returns The response from ChatGPT
   */
  async sendMessage(text, opts = {}) {
    const {
      parentMessageId,
      messageId = uuidv4(),
      timeoutMs,
      onProgress,
      stream = onProgress ? true : false,
      completionParams,
      conversationId
    } = opts;
    let { abortSignal } = opts;
    let abortController = null;
    if (timeoutMs && !abortSignal) {
      abortController = new AbortController();
      abortSignal = abortController.signal;
    }
    const message = {
      role: "user",
      id: messageId,
      conversationId,
      parentMessageId,
      text
    };
    const latestQuestion = message;
    const { messages, maxTokens, numTokens } = await this._buildMessages(
      text,
      opts
    );
    const result = {
      role: "assistant",
      id: uuidv4(),
      conversationId,
      parentMessageId: messageId,
      text: ""
    };
    const responseP = new Promise(
      async (resolve, reject) => {
        var _a, _b;
        const url = `${this._apiBaseUrl}/chat/completions`;
        const headers = {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this._apiKey}`
        };
        const body = {
          max_tokens: maxTokens,
          ...this._completionParams,
          ...completionParams,
          messages,
          stream
        };
        if (this._apiOrg) {
          headers["OpenAI-Organization"] = this._apiOrg;
        }
        if (this._debug) {
          console.log(`sendMessage (${numTokens} tokens)`, body);
        }
        if (stream) {
          fetchSSE(
            url,
            {
              method: "POST",
              headers,
              body: JSON.stringify(body),
              signal: abortSignal,
              onMessage: (data) => {
                var _a2;
                if (data === "[DONE]") {
                  result.text = result.text.trim();
                  return resolve(result);
                }
                try {
                  const response = JSON.parse(data);
                  if (response.id) {
                    result.id = response.id;
                  }
                  if ((_a2 = response.choices) == null ? void 0 : _a2.length) {
                    const delta = response.choices[0].delta;
                    result.delta = delta.content;
                    if (delta == null ? void 0 : delta.content)
                      result.text += delta.content;
                    if (delta.role) {
                      result.role = delta.role;
                    }
                    result.detail = response;
                    onProgress == null ? void 0 : onProgress(result);
                  }
                } catch (err) {
                  console.warn("OpenAI stream SEE event unexpected error", err);
                  return reject(err);
                }
              }
            },
            this._fetch
          ).catch(reject);
        } else {
          try {
            const res = await this._fetch(url, {
              method: "POST",
              headers,
              body: JSON.stringify(body),
              signal: abortSignal
            });
            if (!res.ok) {
              const reason = await res.text();
              const msg = `OpenAI error ${res.status || res.statusText}: ${reason}`;
              const error = new ChatGPTError(msg, { cause: res });
              error.statusCode = res.status;
              error.statusText = res.statusText;
              return reject(error);
            }
            const response = await res.json();
            if (this._debug) {
              console.log(response);
            }
            if (response == null ? void 0 : response.id) {
              result.id = response.id;
            }
            if ((_a = response == null ? void 0 : response.choices) == null ? void 0 : _a.length) {
              const message2 = response.choices[0].message;
              result.text = message2.content;
              if (message2.role) {
                result.role = message2.role;
              }
            } else {
              const res2 = response;
              return reject(
                new Error(
                  `OpenAI error: ${((_b = res2 == null ? void 0 : res2.detail) == null ? void 0 : _b.message) || (res2 == null ? void 0 : res2.detail) || "unknown"}`
                )
              );
            }
            result.detail = response;
            return resolve(result);
          } catch (err) {
            return reject(err);
          }
        }
      }
    ).then(async (message2) => {
      if (message2.detail && !message2.detail.usage) {
        try {
          const promptTokens = numTokens;
          const completionTokens = await this._getTokenCount(message2.text);
          message2.detail.usage = {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: promptTokens + completionTokens,
            estimated: true
          };
        } catch (err) {
        }
      }
      return Promise.all([
        this._upsertMessage(latestQuestion),
        this._upsertMessage(message2)
      ]).then(() => message2);
    });
    if (timeoutMs) {
      if (abortController) {
        ;
        responseP.cancel = () => {
          abortController.abort();
        };
      }
      return pTimeout(responseP, {
        milliseconds: timeoutMs,
        message: "OpenAI timed out waiting for response"
      });
    } else {
      return responseP;
    }
  }
  get apiKey() {
    return this._apiKey;
  }
  set apiKey(apiKey) {
    this._apiKey = apiKey;
  }
  get apiOrg() {
    return this._apiOrg;
  }
  set apiOrg(apiOrg) {
    this._apiOrg = apiOrg;
  }
  async _buildMessages(text, opts) {
    const { systemMessage = this._systemMessage } = opts;
    let { parentMessageId } = opts;
    const userLabel = USER_LABEL_DEFAULT;
    const assistantLabel = ASSISTANT_LABEL_DEFAULT;
    const maxNumTokens = this._maxModelTokens - this._maxResponseTokens;
    let messages = [];
    if (systemMessage) {
      messages.push({
        role: "system",
        content: systemMessage
      });
    }
    const systemMessageOffset = messages.length;
    let nextMessages = text ? messages.concat([
      {
        role: "user",
        content: text,
        name: opts.name
      }
    ]) : messages;
    let numTokens = 0;
    do {
      const prompt = nextMessages.reduce((prompt2, message) => {
        switch (message.role) {
          case "system":
            return prompt2.concat([`Instructions:
${message.content}`]);
          case "user":
            return prompt2.concat([`${userLabel}:
${message.content}`]);
          default:
            return prompt2.concat([`${assistantLabel}:
${message.content}`]);
        }
      }, []).join("\n\n");
      const nextNumTokensEstimate = await this._getTokenCount(prompt);
      const isValidPrompt = nextNumTokensEstimate <= maxNumTokens;
      if (prompt && !isValidPrompt) {
        break;
      }
      messages = nextMessages;
      numTokens = nextNumTokensEstimate;
      if (!isValidPrompt) {
        break;
      }
      if (!parentMessageId) {
        break;
      }
      const parentMessage = await this._getMessageById(parentMessageId);
      if (!parentMessage) {
        break;
      }
      const parentMessageRole = parentMessage.role || "user";
      nextMessages = nextMessages.slice(0, systemMessageOffset).concat([
        {
          role: parentMessageRole,
          content: parentMessage.text,
          name: parentMessage.name
        },
        ...nextMessages.slice(systemMessageOffset)
      ]);
      parentMessageId = parentMessage.parentMessageId;
    } while (true);
    const maxTokens = Math.max(
      1,
      Math.min(this._maxModelTokens - numTokens, this._maxResponseTokens)
    );
    return { messages, maxTokens, numTokens };
  }
  async _getTokenCount(text) {
    text = text.replace(/<\|endoftext\|>/g, "");
    return encode(text).length;
  }
  async _defaultGetMessageById(id) {
    const res = await this._messageStore.get(id);
    return res;
  }
  async _defaultUpsertMessage(message) {
    await this._messageStore.set(message.id, message);
  }
};

// src/chatgpt-unofficial-proxy-api.ts
import imageSize from "image-size";
import mime from "mime-types";
import pTimeout2 from "p-timeout";
import { v4 as uuidv42 } from "uuid";

// src/utils.ts
var uuidv4Re = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function isValidUUIDv4(str) {
  return str && uuidv4Re.test(str);
}

// src/chatgpt-unofficial-proxy-api.ts
var ChatGPTUnofficialProxyAPI = class {
  /**
   * @param fetch - Optional override for the `fetch` implementation to use. Defaults to the global `fetch` function.
   */
  constructor(opts) {
    const {
      accessToken,
      apiReverseProxyUrl = "https://bypass.duti.tech",
      model = "text-davinci-002-render-sha",
      debug = false,
      messageStore,
      headers,
      fetch: fetch3 = fetch2
    } = opts;
    this._accessToken = accessToken;
    this._apiReverseProxyUrl = apiReverseProxyUrl;
    this._debug = !!debug;
    this._model = model;
    this._fetch = fetch3;
    this._headers = headers;
    if (messageStore) {
      this._messageStore = messageStore;
    }
    if (!this._accessToken) {
      throw new Error("ChatGPT invalid accessToken");
    }
    if (!this._fetch) {
      throw new Error("Invalid environment; fetch is not defined");
    }
    if (typeof this._fetch !== "function") {
      throw new Error('Invalid "fetch" is not a function');
    }
  }
  get accessToken() {
    return this._accessToken;
  }
  set accessToken(value) {
    this._accessToken = value;
  }
  /**
   * Sends a message to ChatGPT, waits for the response to resolve, and returns
   * the response.
   *
   * If you want your response to have historical context, you must provide a valid `parentMessageId`.
   *
   * If you want to receive a stream of partial responses, use `opts.onProgress`.
   * If you want to receive the full response, including message and conversation IDs,
   * you can use `opts.onConversationResponse` or use the `ChatGPTAPI.getConversation`
   * helper.
   *
   * Set `debug: true` in the `ChatGPTAPI` constructor to log more info on the full prompt sent to the OpenAI completions API. You can override the `promptPrefix` and `promptSuffix` in `opts` to customize the prompt.
   *
   * @param message - The prompt message to send
   * @param opts.conversationId - Optional ID of a conversation to continue (defaults to a random UUID)
   * @param opts.parentMessageId - Optional ID of the previous message in the conversation (defaults to `undefined`)
   * @param opts.messageId - Optional ID of the message to send (defaults to a random UUID)
   * @param opts.timeoutMs - Optional timeout in milliseconds (defaults to no timeout)
   * @param opts.onProgress - Optional callback which will be invoked every time the partial response is updated
   * @param opts.abortSignal - Optional callback used to abort the underlying `fetch` call using an [AbortController](https://developer.mozilla.org/en-US/docs/Web/API/AbortController)
   *
   * @returns The response from ChatGPT
   */
  async sendMessage(text, opts = {}, files) {
    if (!!opts.conversationId !== !!opts.parentMessageId) {
      throw new Error(
        "ChatGPTUnofficialProxyAPI.sendMessage: conversationId and parentMessageId must both be set or both be undefined"
      );
    }
    if (opts.conversationId && !isValidUUIDv4(opts.conversationId)) {
      throw new Error(
        "ChatGPTUnofficialProxyAPI.sendMessage: conversationId is not a valid v4 UUID"
      );
    }
    if (opts.parentMessageId && !isValidUUIDv4(opts.parentMessageId)) {
      throw new Error(
        "ChatGPTUnofficialProxyAPI.sendMessage: parentMessageId is not a valid v4 UUID"
      );
    }
    if (opts.messageId && !isValidUUIDv4(opts.messageId)) {
      throw new Error(
        "ChatGPTUnofficialProxyAPI.sendMessage: messageId is not a valid v4 UUID"
      );
    }
    const {
      conversationId,
      parentMessageId = uuidv42(),
      messageId = uuidv42(),
      action = "next",
      timeoutMs,
      onProgress
    } = opts;
    let { abortSignal } = opts;
    let abortController = null;
    if (timeoutMs && !abortSignal) {
      abortController = new AbortController();
      abortSignal = abortController.signal;
    }
    if (files && files.length) {
      if (opts.model != "gpt-4") {
        return Promise.reject("only gpt-4 model support files");
      }
      for (let file of files) {
        if (file.file == null && (file.fileId == null || file.filename == null || file.fileSize == null || file.width == null || file.height == null)) {
          return Promise.reject("required file params is null");
        }
        file.mimeType = mime.lookup(file.filename);
        if (file.fileId == null) {
          const uploadResult = await this.uploadFile(file.filename, file.file);
          file.fileId = uploadResult.file_id;
          file.fileSize = uploadResult.file_size;
        }
        if (file.mimeType && file.mimeType.startsWith("image") && (null == file.width || null == file.height)) {
          const dimensions = imageSize(file.file);
          file.width = dimensions.width;
          file.height = dimensions.height;
        }
      }
    }
    const message = {
      role: "user",
      id: messageId,
      conversationId,
      parentMessageId,
      text
    };
    const latestQuestion = message;
    const body = {
      action,
      messages: [
        {
          id: messageId,
          author: {
            role: "user"
          },
          content: files && files.length ? {
            content_type: "multimodal_text",
            parts: [
              ...files.map((file) => ({
                asset_pointer: `file-service://${file.fileId}`,
                ...file.fileSize && { size_bytes: file.fileSize },
                ...file.width && { width: file.width },
                ...file.height && { height: file.height }
              })),
              text
            ]
          } : {
            content_type: "text",
            parts: [text]
          },
          ...files && files.length && {
            metadata: {
              attachments: files.map((file) => ({
                name: file.filename,
                id: file.fileId,
                size: file.fileSize,
                ...file.mimeType && { mimeType: file.mimeType },
                ...file.width && { width: file.width },
                ...file.height && { height: file.height }
              }))
            }
          }
        }
      ],
      model: opts.model || this._model,
      parent_message_id: parentMessageId
    };
    if (conversationId) {
      body.conversation_id = conversationId;
    }
    const result = {
      role: "assistant",
      id: uuidv42(),
      parentMessageId: messageId,
      conversationId,
      text: ""
    };
    const responseP = new Promise((resolve, reject) => {
      const url = `${this._apiReverseProxyUrl}/backend-api/conversation`;
      const headers = {
        ...this._headers,
        Authorization: `Bearer ${this._accessToken}`,
        Accept: "text/event-stream",
        "Content-Type": "application/json"
      };
      if (this._debug) {
        console.log("POST", url, { body, headers });
      }
      fetchSSE(
        url,
        {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: abortSignal,
          onMessage: (data) => {
            var _a, _b, _c;
            if (data === "[DONE]") {
              return resolve(result);
            }
            try {
              const convoResponseEvent = JSON.parse(data);
              if (convoResponseEvent.conversation_id) {
                result.conversationId = convoResponseEvent.conversation_id;
              }
              if ((_a = convoResponseEvent.message) == null ? void 0 : _a.id) {
                result.id = convoResponseEvent.message.id;
              }
              const message2 = convoResponseEvent.message;
              if (message2) {
                let text2 = (_c = (_b = message2 == null ? void 0 : message2.content) == null ? void 0 : _b.parts) == null ? void 0 : _c[0];
                if (text2) {
                  result.text = text2;
                  if (onProgress) {
                    onProgress(result);
                  }
                }
              }
            } catch (err) {
              if (this._debug) {
                console.warn("chatgpt unexpected JSON error", err);
              }
            }
          },
          onError: (err) => {
            reject(err);
          }
        },
        this._fetch
      ).catch((err) => {
        const errMessageL = err.toString().toLowerCase();
        if (result.text && (errMessageL === "error: typeerror: terminated" || errMessageL === "typeerror: terminated")) {
          return resolve(result);
        } else {
          return reject(err);
        }
      });
    }).then(async (message2) => {
      await this.upsertMessage(latestQuestion);
      await this.upsertMessage(message2);
      return message2;
    });
    if (timeoutMs) {
      if (abortController) {
        ;
        responseP.cancel = () => {
          abortController.abort();
        };
      }
      return pTimeout2(responseP, {
        milliseconds: timeoutMs,
        message: "ChatGPT timed out waiting for response"
      });
    } else {
      return responseP;
    }
  }
  async getFileUploadUrl(uploadInfo) {
    const url = `${this._apiReverseProxyUrl}/backend-api/files`;
    const headers = {
      ...this._headers,
      Authorization: `Bearer ${this._accessToken}`,
      "Content-Type": "application/json"
    };
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(uploadInfo)
    });
    if (response.status >= 300) {
      return Promise.reject(`statusCode:${response.status}`);
    }
    const uploadResult = await response.json();
    if ("success" != uploadResult.status) {
      return Promise.reject(`status:${uploadResult.status}`);
    }
    return uploadResult;
  }
  /**
   * call after getFileUploadUrl
   * this upload could be called directly from browser or client, directly upload to azure
   * @param url
   * @param file
   */
  async upload(url, file) {
    const headers = {
      ...this._headers,
      "x-ms-blob-type": "BlockBlob",
      "x-ms-version": "2020-04-08",
      Origin: "https://chat.openai.com",
      "Content-Type": "application/octet-stream"
    };
    const response = await fetch(url, {
      method: "put",
      headers,
      body: file
    });
    if (response.status >= 300) {
      return Promise.reject(`statusCode:${response.status}`);
    }
    return true;
  }
  /**
   * call after file uploaded
   * @param fileId
   */
  async checkFileUploaded(fileId) {
    if (!fileId) {
      return Promise.reject(`fileId can not be null`);
    }
    const url = `${this._apiReverseProxyUrl}/backend-api/files/${fileId}/uploaded`;
    const headers = {
      ...this._headers,
      Authorization: `Bearer ${this._accessToken}`,
      "Content-Type": "application/json"
    };
    const response = await fetch(url, {
      method: "post",
      headers,
      body: "{}"
    });
    if (response.status >= 300) {
      return Promise.reject(`statusCode:${response.status}`);
    }
    const uploadResult = await response.json();
    if ("success" != uploadResult.status) {
      return Promise.reject(`checkFileUploaded status:${uploadResult.status}`);
    }
    return true;
  }
  /**
   * upload file
   * @param filename
   * @param file
   */
  async uploadFile(filename, file) {
    const uploadInfo = {
      file_name: filename,
      file_size: file.length,
      use_case: "multimodal"
    };
    const uploadResult = await this.getFileUploadUrl(uploadInfo);
    uploadResult["file_size"] = uploadInfo.file_size;
    await this.upload(uploadResult.upload_url, file);
    await this.checkFileUploaded(uploadResult.file_id);
    return uploadResult;
  }
  /**
   * upload file
   * @param filename
   * @param file
   */
  async genTitle(conversationId, parentMessageId) {
    if (!conversationId) {
      return Promise.reject(`conversationId can not be null`);
    }
    if (!parentMessageId) {
      return Promise.reject(`parentMessageId can not be null`);
    }
    const url = `${this._apiReverseProxyUrl}/backend-api/conversation/gen_title/${conversationId}`;
    const headers = {
      ...this._headers,
      Authorization: `Bearer ${this._accessToken}`,
      "Content-Type": "application/json"
    };
    const response = await fetch(url, {
      method: "post",
      headers,
      body: JSON.stringify({
        message_id: parentMessageId
      })
    });
    if (response.status >= 300) {
      return Promise.reject(`statusCode:${response.status}`);
    }
    const result = await response.json();
    if (!result.title) {
      return Promise.reject(`genTitle failed:${result}`);
    }
    return result.title;
  }
  async upsertMessage(message) {
    if (this._messageStore)
      await this._messageStore.set(message.id, message);
  }
};
export {
  ChatGPTAPI,
  ChatGPTError,
  ChatGPTUnofficialProxyAPI,
  openai
};
//# sourceMappingURL=index.js.map