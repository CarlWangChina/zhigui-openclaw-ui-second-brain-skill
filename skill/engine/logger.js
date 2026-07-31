'use strict';

/**
 * 分级日志系统 (P2-4.2)
 *
 * 提供 debug/info/warn/error 四级日志，
 * 支持分类过滤、文件持久化和自动轮转。
 * 零依赖，仅用 Node.js 内置模块。
 *
 * @module logger
 */

const fs = require('fs');
const path = require('path');
const { LOG_MAX_SIZE, LOG_MAX_AGE_DAYS } = require('./constants');

const IS_DEV = process.env.ZHIGUI_DEV === '1';

let _logDir = null;
let _currentDate = null;
let _currentStream = null;
let _streamError = false;

/**
 * 初始化日志目录
 * @param {string} dataDir - .zhigui 数据目录路径
 */
function init(dataDir) {
  if (!dataDir) return;
  _logDir = path.join(dataDir, 'logs');
  try {
    if (!fs.existsSync(_logDir)) {
      fs.mkdirSync(_logDir, { recursive: true });
    }
    _openStream();
  } catch {
    // 日志目录创建失败时降级为仅 stdout
    _logDir = null;
  }
}

/**
 * 打开当天日志文件的写入流
 * @private
 */
function _openStream() {
  if (!_logDir) return;
  _currentDate = _dateStr();
  const logFile = path.join(_logDir, `${_currentDate}.log`);
  _currentStream = fs.createWriteStream(logFile, { flags: 'a' });
  _streamError = false;
  _currentStream.on('error', () => { _streamError = true; });
  // 清理过期日志
  _cleanOldLogs();
}

/**
 * 检查并执行日志轮转
 * @private
 */
function _checkRotation() {
  if (!_logDir || !_currentStream) return;
  const today = _dateStr();
  if (today !== _currentDate || _streamError) {
    _currentStream.end();
    _openStream();
    return;
  }
  // 检查文件大小
  try {
    const logFile = path.join(_logDir, `${_currentDate}.log`);
    const stat = fs.statSync(logFile);
    if (stat.size > LOG_MAX_SIZE) {
      const rotated = path.join(_logDir, `${_currentDate}.${Date.now()}.log`);
      fs.renameSync(logFile, rotated);
      _currentStream.end();
      _openStream();
    }
  } catch {
    // 忽略轮转错误
  }
}

/**
 * 清理过期日志文件
 * @private
 */
function _cleanOldLogs() {
  if (!_logDir) return;
  try {
    const files = fs.readdirSync(_logDir);
    const now = Date.now();
    const maxAge = LOG_MAX_AGE_DAYS * 86400000;
    for (const f of files) {
      if (!f.endsWith('.log')) continue;
      const fp = path.join(_logDir, f);
      const stat = fs.statSync(fp);
      if (now - stat.mtimeMs > maxAge) {
        fs.unlinkSync(fp);
      }
    }
  } catch {
    // 忽略清理错误
  }
}

/**
 * 格式化当前日期为 YYYY-MM-DD
 * @returns {string}
 * @private
 */
function _dateStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 格式化时间戳为 HH:MM:SS.mmm
 * @returns {string}
 * @private
 */
function _timeStr() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

/**
 * 内部写入函数
 * @param {string} level - 日志级别
 * @param {string} category - 分类
 * @param {string} message - 消息
 * @param {*} [data] - 附加数据
 * @private
 */
function _write(level, category, message, data) {
  const line = `[${_timeStr()}] [${level}] [${category}] ${message}`;
  const dataStr = data !== undefined ? ` ${JSON.stringify(data)}` : '';
  const fullLine = line + dataStr;

  // stdout 输出
  if (level === 'ERROR') {
    process.stderr.write(fullLine + '\n');
  } else if (level === 'WARN' || level === 'INFO' || IS_DEV) {
    process.stdout.write(fullLine + '\n');
  }

  // 文件输出
  if (_logDir && _currentStream) {
    _checkRotation();
    try {
      _currentStream.write(fullLine + '\n');
    } catch {
      // 忽略文件写入错误
    }
  }
}

/**
 * Debug 级别日志（仅开发模式输出）
 * @param {string} category - 分类，如 'storage'、'brain-index'
 * @param {string} message - 消息
 * @param {*} [data] - 附加数据
 */
function debug(category, message, data) {
  if (IS_DEV) _write('DEBUG', category, message, data);
}

/**
 * Info 级别日志
 * @param {string} category
 * @param {string} message
 * @param {*} [data]
 */
function info(category, message, data) {
  _write('INFO', category, message, data);
}

/**
 * Warn 级别日志
 * @param {string} category
 * @param {string} message
 * @param {*} [data]
 */
function warn(category, message, data) {
  _write('WARN', category, message, data);
}

/**
 * Error 级别日志（始终输出）
 * @param {string} category
 * @param {string} message
 * @param {*} [data]
 */
function error(category, message, data) {
  _write('ERROR', category, message, data);
}

module.exports = {
  init,
  debug,
  info,
  warn,
  error,
};
