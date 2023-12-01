import imageSize from 'image-size'
import Keyv from 'keyv'
import mime from 'mime-types'
import pTimeout from 'p-timeout'
import QuickLRU from 'quick-lru'
import { v4 as uuidv4 } from 'uuid'

import * as types from './types'
import { fetch as globalFetch } from './fetch'
import { fetchSSE } from './fetch-sse'
import { UploadInfo } from './types'
import { isValidUUIDv4 } from './utils'

export class ChatGPTUnofficialProxyAPI {
  protected _accessToken: string
  protected _apiReverseProxyUrl: string
  protected _debug: boolean
  protected _model: string
  protected _headers: Record<string, string>
  protected _fetch: types.FetchFn
  protected _messageStore: Keyv<types.ChatMessage>

  /**
   * @param fetch - Optional override for the `fetch` implementation to use. Defaults to the global `fetch` function.
   */
  constructor(opts: {
    accessToken: string

    /** @defaultValue `https://bypass.duti.tech` **/
    apiReverseProxyUrl?: string

    /** @defaultValue `text-davinci-002-render-sha` **/
    model?: string

    /** @defaultValue `false` **/
    debug?: boolean

    /** @defaultValue `undefined` **/
    headers?: Record<string, string>

    fetch?: types.FetchFn

    messageStore?: Keyv
  }) {
    const {
      accessToken,
      apiReverseProxyUrl = 'https://bypass.duti.tech',
      model = 'text-davinci-002-render-sha',
      debug = false,
      messageStore,
      headers,
      fetch = globalFetch
    } = opts

    this._accessToken = accessToken
    this._apiReverseProxyUrl = apiReverseProxyUrl
    this._debug = !!debug
    this._model = model
    this._fetch = fetch
    this._headers = headers

    if (messageStore) {
      this._messageStore = messageStore
    }

    if (!this._accessToken) {
      throw new Error('ChatGPT invalid accessToken')
    }

    if (!this._fetch) {
      throw new Error('Invalid environment; fetch is not defined')
    }

    if (typeof this._fetch !== 'function') {
      throw new Error('Invalid "fetch" is not a function')
    }
  }

  get accessToken(): string {
    return this._accessToken
  }

  set accessToken(value: string) {
    this._accessToken = value
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
  async sendMessage(
    text: string,
    opts: types.SendMessageBrowserOptions = {},
    files: [
      {
        mimeType: string
        width: number
        height: number
        fileSize: number
        fileId: string
        filename: string
        file: Buffer
      }
    ]
  ): Promise<types.ChatMessage> {
    if (!!opts.conversationId !== !!opts.parentMessageId) {
      throw new Error(
        'ChatGPTUnofficialProxyAPI.sendMessage: conversationId and parentMessageId must both be set or both be undefined'
      )
    }

    if (opts.conversationId && !isValidUUIDv4(opts.conversationId)) {
      throw new Error(
        'ChatGPTUnofficialProxyAPI.sendMessage: conversationId is not a valid v4 UUID'
      )
    }

    if (opts.parentMessageId && !isValidUUIDv4(opts.parentMessageId)) {
      throw new Error(
        'ChatGPTUnofficialProxyAPI.sendMessage: parentMessageId is not a valid v4 UUID'
      )
    }

    if (opts.messageId && !isValidUUIDv4(opts.messageId)) {
      throw new Error(
        'ChatGPTUnofficialProxyAPI.sendMessage: messageId is not a valid v4 UUID'
      )
    }

    const {
      conversationId,
      parentMessageId = uuidv4(),
      messageId = uuidv4(),
      action = 'next',
      timeoutMs,
      onProgress
    } = opts

    let { abortSignal } = opts

    let abortController: AbortController = null
    if (timeoutMs && !abortSignal) {
      abortController = new AbortController()
      abortSignal = abortController.signal
    }
    if (files && files.length) {
      if (opts.model != 'gpt-4') {
        return Promise.reject('only gpt-4 model support files')
      }
      for (let file of files) {
        if (
          file.file == null &&
          (file.fileId == null ||
            file.filename == null ||
            file.fileSize == null ||
            file.width == null ||
            file.height == null)
        ) {
          return Promise.reject('required file params is null')
        }
        file.mimeType = mime.lookup(file.filename)
        if (file.fileId == null) {
          const uploadResult = await this.uploadFile(file.filename, file.file)
          file.fileId = uploadResult.file_id
          file.fileSize = uploadResult.file_size
        }
        if (
          file.mimeType &&
          file.mimeType.startsWith('image') &&
          (null == file.width || null == file.height)
        ) {
          const dimensions = imageSize(file.file)
          file.width = dimensions.width
          file.height = dimensions.height
        }
      }
    }
    const message: types.ChatMessage = {
      role: 'user',
      id: messageId,
      conversationId,
      parentMessageId,
      text
    }

    const latestQuestion = message

    const body: types.ConversationJSONBody = {
      action,
      messages: [
        {
          id: messageId,
          author: {
            role: 'user'
          },
          content:
            files && files.length
              ? {
                  content_type: 'multimodal_text',
                  parts: [
                    ...files.map((file) => ({
                      asset_pointer: `file-service://${file.fileId}`,
                      ...(file.fileSize && { size_bytes: file.fileSize }),
                      ...(file.width && { width: file.width }),
                      ...(file.height && { height: file.height })
                    })),
                    text
                  ]
                }
              : {
                  content_type: 'text',
                  parts: [text]
                },
          ...(files &&
            files.length && {
              metadata: {
                attachments: files.map((file) => ({
                  name: file.filename,
                  id: file.fileId,
                  size: file.fileSize,
                  ...(file.mimeType && { mimeType: file.mimeType }),
                  ...(file.width && { width: file.width }),
                  ...(file.height && { height: file.height })
                }))
              }
            })
        }
      ],
      model: opts.model || this._model,
      parent_message_id: parentMessageId
    }

    if (conversationId) {
      body.conversation_id = conversationId
    }

    const result: types.ChatMessage = {
      role: 'assistant',
      id: uuidv4(),
      parentMessageId: messageId,
      conversationId,
      text: ''
    }

    const responseP = new Promise<types.ChatMessage>((resolve, reject) => {
      const url = `${this._apiReverseProxyUrl}/backend-api/conversation`
      const headers = {
        ...this._headers,
        Authorization: `Bearer ${this._accessToken}`,
        Accept: 'text/event-stream',
        'Content-Type': 'application/json'
      }

      if (this._debug) {
        console.log('POST', url, { body, headers })
      }

      fetchSSE(
        url,
        {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: abortSignal,
          onMessage: (data: string) => {
            if (data === '[DONE]') {
              return resolve(result)
            }

            try {
              const convoResponseEvent: types.ConversationResponseEvent =
                JSON.parse(data)
              if (convoResponseEvent.conversation_id) {
                result.conversationId = convoResponseEvent.conversation_id
              }

              if (convoResponseEvent.message?.id) {
                result.id = convoResponseEvent.message.id
              }

              const message = convoResponseEvent.message
              // console.log('event', JSON.stringify(convoResponseEvent, null, 2))

              if (message) {
                let text = message?.content?.parts?.[0]

                if (text) {
                  result.text = text

                  if (onProgress) {
                    onProgress(result)
                  }
                }
              }
            } catch (err) {
              if (this._debug) {
                console.warn('chatgpt unexpected JSON error', err)
              }
              // reject(err)
            }
          },
          onError: (err) => {
            reject(err)
          }
        },
        this._fetch
      ).catch((err) => {
        const errMessageL = err.toString().toLowerCase()

        if (
          result.text &&
          (errMessageL === 'error: typeerror: terminated' ||
            errMessageL === 'typeerror: terminated')
        ) {
          // OpenAI sometimes forcefully terminates the socket from their end before
          // the HTTP request has resolved cleanly. In my testing, these cases tend to
          // happen when OpenAI has already send the last `response`, so we can ignore
          // the `fetch` error in this case.
          return resolve(result)
        } else {
          return reject(err)
        }
      })
    }).then(async (message) => {
      // if (message.detail && !message.detail.usage) {
      //   try {
      //     const promptTokens = numTokens
      //     const completionTokens = await this._getTokenCount(message.text)
      //     message.detail.usage = {
      //       prompt_tokens: promptTokens,
      //       completion_tokens: completionTokens,
      //       total_tokens: promptTokens + completionTokens,
      //       estimated: true
      //     }
      //   } catch (err) {
      //     // TODO: this should really never happen, but if it does,
      //     // we should handle notify the user gracefully
      //   }
      // }
      await this.upsertMessage(latestQuestion)
      await this.upsertMessage(message)
      return message
    })

    if (timeoutMs) {
      if (abortController) {
        // This will be called when a timeout occurs in order for us to forcibly
        // ensure that the underlying HTTP request is aborted.
        ;(responseP as any).cancel = () => {
          abortController.abort()
        }
      }

      return pTimeout(responseP, {
        milliseconds: timeoutMs,
        message: 'ChatGPT timed out waiting for response'
      })
    } else {
      return responseP
    }
  }

  async getFileUploadUrl(uploadInfo: UploadInfo) {
    const url = `${this._apiReverseProxyUrl}/backend-api/files`
    const headers = {
      ...this._headers,
      Authorization: `Bearer ${this._accessToken}`,
      'Content-Type': 'application/json'
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(uploadInfo)
    })
    if (response.status >= 300) {
      return Promise.reject(`statusCode:${response.status}`)
    }
    const uploadResult = await response.json()
    if ('success' != uploadResult.status) {
      return Promise.reject(`status:${uploadResult.status}`)
    }
    return uploadResult
  }

  /**
   * call after getFileUploadUrl
   * this upload could be called directly from browser or client, directly upload to azure
   * @param url
   * @param file
   */
  async upload(url: string, file) {
    const headers = {
      ...this._headers,
      'x-ms-blob-type': 'BlockBlob',
      'x-ms-version': '2020-04-08',
      Origin: 'https://chat.openai.com',
      'Content-Type': 'application/octet-stream'
    }
    const response = await fetch(url, {
      method: 'put',
      headers,
      body: file
    })
    if (response.status >= 300) {
      return Promise.reject(`statusCode:${response.status}`)
    }
    return true
  }

  /**
   * call after file uploaded
   * @param fileId
   */
  async checkFileUploaded(fileId: string) {
    if (!fileId) {
      return Promise.reject(`fileId can not be null`)
    }
    const url = `${this._apiReverseProxyUrl}/backend-api/files/${fileId}/uploaded`
    const headers = {
      ...this._headers,
      Authorization: `Bearer ${this._accessToken}`,
      'Content-Type': 'application/json'
    }
    const response = await fetch(url, {
      method: 'post',
      headers,
      body: '{}'
    })
    if (response.status >= 300) {
      return Promise.reject(`statusCode:${response.status}`)
    }
    const uploadResult = await response.json()
    if ('success' != uploadResult.status) {
      return Promise.reject(`checkFileUploaded status:${uploadResult.status}`)
    }
    return true
  }

  /**
   * upload file
   * @param filename
   * @param file
   */
  async uploadFile(filename: string, file: Buffer) {
    const uploadInfo: UploadInfo = {
      file_name: filename,
      file_size: file.length,
      use_case: 'multimodal'
    }
    const uploadResult = await this.getFileUploadUrl(uploadInfo)
    uploadResult['file_size'] = uploadInfo.file_size
    await this.upload(uploadResult.upload_url, file)
    await this.checkFileUploaded(uploadResult.file_id)
    return uploadResult
  }
  protected async upsertMessage(message: types.ChatMessage): Promise<void> {
    if (this._messageStore) await this._messageStore.set(message.id, message)
  }
}
