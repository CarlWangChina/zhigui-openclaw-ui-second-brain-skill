'use strict';

/**
 * 统一日期工具模块 —— 解决时区偏移问题 (P0-2.3)
 *
 * 核心原则：所有日期字符串操作使用本地时区的年/月/日分量，
 * 绝不使用 toISOString()（它返回 UTC，会在 UTC+N 时区的凌晨产生日期偏移）。
 *
 * @module date-utils
 */

/**
 * 默认时区（可通过环境变量覆盖）
 */
const DEFAULT_TIMEZONE = process.env.ZHIGUI_TIMEZONE || 'Asia/Shanghai';

/**
 * 使用指定时区获取今天的日期字符串 (YYYY-MM-DD)
 * 基于 Intl.DateTimeFormat 提取年/月/日分量，避免 UTC 偏移。
 *
 * @param {string} [timezone=DEFAULT_TIMEZONE] - IANA 时区标识符
 * @returns {string} YYYY-MM-DD 格式的日期字符串
 */
function todayStr(timezone = DEFAULT_TIMEZONE) {
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    // en-CA 格式天然输出 YYYY-MM-DD
    return fmt.format(new Date());
  } catch {
    // 时区无效时回退到本地时间分量提取
    const d = new Date();
    return _formatYMD(d.getFullYear(), d.getMonth() + 1, d.getDate());
  }
}

/**
 * 安全的日期递增：返回 dateStr 后一天的日期字符串
 * 使用本地时间分量操作，不调用 toISOString()。
 *
 * @param {string} dateStr - YYYY-MM-DD 格式
 * @param {number} [offset=1] - 偏移天数（正数向后，负数向前）
 * @returns {string} YYYY-MM-DD 格式
 */
function nextDay(dateStr, offset = 1) {
  const { year, month, day } = _parseYMD(dateStr);
  // 使用 UTC 构造 Date 对象避免本地时区干扰分量计算
  // 但只取年月日分量做算术，不用 toISOString
  const d = new Date(Date.UTC(year, month - 1, day));
  d.setUTCDate(d.getUTCDate() + offset);
  return _formatYMD(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/**
 * 安全的天数差计算：返回 targetDateStr 距今天的天数
 * 正数表示未来，负数表示过去，0 表示今天。
 *
 * @param {string} targetDateStr - YYYY-MM-DD 格式
 * @param {string} [baseDateStr] - 基准日期，默认今天
 * @returns {number} 天数差
 */
function daysBetween(targetDateStr, baseDateStr) {
  const base = baseDateStr || todayStr();
  const { year: by, month: bm, day: bd } = _parseYMD(base);
  const { year: ty, month: tm, day: td } = _parseYMD(targetDateStr);
  const baseMs = Date.UTC(by, bm - 1, bd);
  const targetMs = Date.UTC(ty, tm - 1, td);
  return Math.round((targetMs - baseMs) / 86400000);
}

/**
 * 格式化 Date 对象为指定时区的日期字符串
 *
 * @param {Date} date - 日期对象
 * @param {string} [timezone=DEFAULT_TIMEZONE] - IANA 时区标识符
 * @returns {string} YYYY-MM-DD 格式
 */
function formatDate(date, timezone = DEFAULT_TIMEZONE) {
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    return fmt.format(date);
  } catch {
    return _formatYMD(date.getFullYear(), date.getMonth() + 1, date.getDate());
  }
}

/**
 * 格式化 Date 对象为指定时区的日期时间字符串
 *
 * @param {Date} date - 日期对象
 * @param {string} [timezone=DEFAULT_TIMEZONE] - IANA 时区标识符
 * @returns {string} YYYY-MM-DD HH:MM 格式
 */
function formatDateTime(date, timezone = DEFAULT_TIMEZONE) {
  try {
    const dateStr = formatDate(date, timezone);
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    return `${dateStr} ${fmt.format(date)}`;
  } catch {
    const h = String(date.getHours()).padStart(2, '0');
    const m = String(date.getMinutes()).padStart(2, '0');
    return `${formatDate(date)} ${h}:${m}`;
  }
}

/**
 * 获取指定日期是星期几
 *
 * @param {string} dateStr - YYYY-MM-DD 格式
 * @returns {number} 0=周日, 1=周一, ..., 6=周六
 */
function getWeekday(dateStr) {
  const { year, month, day } = _parseYMD(dateStr);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/**
 * 将时间字符串转换为分钟数
 *
 * @param {string} timeStr - HH:MM 格式
 * @returns {number} 分钟数（如 "14:30" → 870）
 */
function timeToMinutes(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m;
}

/**
 * 将分钟数转换为时间字符串
 *
 * @param {number} minutes - 分钟数
 * @returns {string} HH:MM 格式
 */
function minutesToTime(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// ─── 内部辅助函数 ───

/**
 * 解析 YYYY-MM-DD 字符串为年月日分量
 * @param {string} dateStr
 * @returns {{year: number, month: number, day: number}}
 * @private
 */
function _parseYMD(dateStr) {
  const parts = String(dateStr).split('-');
  return {
    year: parseInt(parts[0], 10),
    month: parseInt(parts[1], 10),
    day: parseInt(parts[2], 10),
  };
}

/**
 * 将年月日分量格式化为 YYYY-MM-DD
 * @param {number} year
 * @param {number} month
 * @param {number} day
 * @returns {string}
 * @private
 */
function _formatYMD(year, month, day) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

module.exports = {
  DEFAULT_TIMEZONE,
  todayStr,
  nextDay,
  daysBetween,
  formatDate,
  formatDateTime,
  getWeekday,
  timeToMinutes,
  minutesToTime,
};
