import { window } from '@kit.ArkUI'
import { common } from '@kit.AbilityKit'
import { GlobalVariable } from 'constants'

/**
 * 错误处理选项接口
 */
export interface ErrorHandlerOptions<T> {
  errorMessage?: string
  successMessage?: string
  onError?: (error: Error) => void
  onSuccess?: (result: T) => void
}

/**
 * 统一错误处理工具类
 * 提供标准化的错误提示和日志记录
 */
export class ErrorHandler {
  private static readonly DEFAULT_ERROR_MESSAGE: string = '操作失败，请稍后重试'
  private static readonly NETWORK_ERROR_MESSAGE: string = '网络连接失败，请检查网络'
  private static readonly TIMEOUT_ERROR_MESSAGE: string = '请求超时，请重试'

  private static showToast(message: string): void {
    const context = AppStorage.get<common.UIAbilityContext>(GlobalVariable.ABILITY_CONTEXT_KEY)
    if (!context) {
      return
    }
    window.getLastWindow(context).then((win) => {
      try {
        win.getUIContext().getPromptAction().showToast({ message, duration: 2000 })
      } catch {
      }
    }).catch(() => {
    })
  }

  /**
   * 显示错误提示
   */
  static showError(message?: string): void {
    try {
      ErrorHandler.showToast(message || ErrorHandler.DEFAULT_ERROR_MESSAGE)
    } catch (e) {
      console.error('[ErrorHandler] Failed to show toast:', e)
    }
  }

  /**
   * 显示成功提示
   */
  static showSuccess(message: string): void {
    try {
      ErrorHandler.showToast(message)
    } catch (e) {
      console.error('[ErrorHandler] Failed to show toast:', e)
    }
  }

  /**
   * 处理网络请求错误
   */
  static handleNetworkError(error: Error, customMessage?: string): void {
    console.error('[ErrorHandler] Network error:', error)

    if (customMessage) {
      ErrorHandler.showError(customMessage)
      return
    }

    // 根据错误类型显示不同提示
    if (error.message.includes('timeout')) {
      ErrorHandler.showError(ErrorHandler.TIMEOUT_ERROR_MESSAGE)
    } else if (error.message.includes('network')) {
      ErrorHandler.showError(ErrorHandler.NETWORK_ERROR_MESSAGE)
    } else {
      ErrorHandler.showError(ErrorHandler.DEFAULT_ERROR_MESSAGE)
    }
  }

  /**
   * 执行异步操作并统一处理错误
   */
  static async execute<T>(
    operation: () => Promise<T>,
    options?: ErrorHandlerOptions<T>
  ): Promise<T | null> {
    try {
      const result = await operation()

      if (options?.successMessage) {
        ErrorHandler.showSuccess(options.successMessage)
      }

      if (options?.onSuccess) {
        options.onSuccess(result)
      }

      return result
    } catch (error) {
      console.error('[ErrorHandler] Operation failed:', error)

      if (options?.errorMessage) {
        ErrorHandler.showError(options.errorMessage)
      } else {
        ErrorHandler.handleNetworkError(error as Error)
      }

      if (options?.onError) {
        options.onError(error as Error)
      }

      return null
    }
  }

  /**
   * 记录调试日志
   */
  static logDebug(tag: string, message: string, data?: Object): void {
    console.debug(`[${tag}] ${message}`, data ? JSON.stringify(data) : '')
  }

  /**
   * 记录信息日志
   */
  static logInfo(tag: string, message: string, data?: Object): void {
    console.info(`[${tag}] ${message}`, data ? JSON.stringify(data) : '')
  }

  /**
   * 记录错误日志
   */
  static logError(tag: string, message: string, error?: Error): void {
    console.error(`[${tag}] ${message}`, error ? error.message : '')
  }
}
