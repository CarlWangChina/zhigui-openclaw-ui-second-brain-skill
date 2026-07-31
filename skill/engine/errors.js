'use strict';

/**
 * 统一错误类型层级 (P1-4.1)
 *
 * 所有 ZhiGui 业务错误都继承自 ZhiGuiError，
 * 携带 error code 供上层统一处理。
 *
 * @module errors
 */

/**
 * 基础错误类
 */
class ZhiGuiError extends Error {
  /**
   * @param {string} code - 错误代码，如 'VALIDATION_ERROR'
   * @param {string} message - 人类可读的错误描述
   * @param {*} [details] - 附加详情（任意类型）
   */
  constructor(code, message, details) {
    super(message);
    this.name = 'ZhiGuiError';
    this.code = code;
    this.details = details;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, ZhiGuiError);
    }
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      details: this.details,
    };
  }
}

/**
 * 输入校验错误（参数格式/类型/范围不合法）
 */
class ValidationError extends ZhiGuiError {
  constructor(message, details) {
    super('VALIDATION_ERROR', message, details);
    this.name = 'ValidationError';
  }
}

/**
 * 资源不存在错误
 */
class NotFoundError extends ZhiGuiError {
  constructor(message, details) {
    super('NOT_FOUND', message, details);
    this.name = 'NotFoundError';
  }
}

/**
 * 冲突错误（资源状态冲突、优先级竞争等）
 */
class ConflictError extends ZhiGuiError {
  constructor(message, details) {
    super('CONFLICT', message, details);
    this.name = 'ConflictError';
  }
}

/**
 * 状态锁错误（获取锁失败、锁超时等）
 */
class StateLockError extends ZhiGuiError {
  constructor(message, details) {
    super('STATE_LOCK_ERROR', message, details);
    this.name = 'StateLockError';
  }
}

/**
 * 陈旧数据错误（函数执行期间数据被其他进程修改）
 * 用于 P0-2.2 持久化顺序保障。
 */
class StaleDataError extends ZhiGuiError {
  constructor(message, details) {
    super('STALE_DATA', message, details);
    this.name = 'StaleDataError';
  }
}

/**
 * 判断一个错误是否为 ZhiGuiError（或其子类）
 * @param {*} err
 * @returns {boolean}
 */
function isZhiGuiError(err) {
  return err instanceof ZhiGuiError;
}

/**
 * 将任意错误转换为统一的 JSON 响应格式
 * @param {*} err
 * @returns {{ success: false, error: { code: string, message: string, details: * } }}
 */
function toErrorResponse(err) {
  if (err instanceof ZhiGuiError) {
    return {
      success: false,
      error: err.toJSON(),
    };
  }
  return {
    success: false,
    error: {
      code: 'INTERNAL',
      message: 'An unexpected error occurred',
      details: err && err.message ? err.message : String(err),
    },
  };
}

module.exports = {
  ZhiGuiError,
  ValidationError,
  NotFoundError,
  ConflictError,
  StateLockError,
  StaleDataError,
  isZhiGuiError,
  toErrorResponse,
};
