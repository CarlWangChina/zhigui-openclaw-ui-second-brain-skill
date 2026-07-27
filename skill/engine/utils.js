'use strict';

/**
 * Shared utility functions (Task 1.4)
 *
 * Eliminates duplication between dashboard/server.js and engine/server.js.
 * Both modules import from this single source of truth.
 *
 * @module utils
 */

const DateUtils = require('./date-utils');

// ─── ID generation ───────────────────────────────────────────────────────

/**
 * Generate a unique ID with a prefix.
 * Unified format: prefix_base36timestamp_base36random
 * @param {string} prefix - ID prefix (e.g. 't', 'g', 'n', 'e')
 * @returns {string} Unique ID string
 */
function genId(prefix) {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ─── Date utilities (delegate to date-utils for timezone correctness) ────

/**
 * Get today's date string in YYYY-MM-DD format (timezone-aware).
 * @returns {string}
 */
function todayStr() {
  return DateUtils.todayStr();
}

/**
 * Calculate days between today and a date string.
 * @param {string} dateStr - Date in YYYY-MM-DD format
 * @returns {number|null} Days difference (negative = past)
 */
function daysBetween(dateStr) {
  if (!dateStr) return null;
  return DateUtils.daysBetween(dateStr);
}

// ─── Input validation (security) ─────────────────────────────────────────

/**
 * Validate and normalize a time string (HH:MM).
 * Returns normalized string, empty string for empty input, or null if invalid.
 * @param {string|*} str - Input time string
 * @returns {string|null} Normalized "HH:MM" or null if invalid
 */
function normalizeTime(str) {
  if (str === undefined || str === null || str === '') return '';
  if (typeof str !== 'string') str = String(str);
  const m = /^(\d{1,2}):(\d{2})$/.exec(str.trim());
  if (!m) return null;
  const hh = parseInt(m[1], 10), mm = parseInt(m[2], 10);
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
}

/**
 * Validate and normalize a date string (YYYY-MM-DD).
 * Returns normalized string, empty string for empty input, or null if invalid.
 * @param {string|*} str - Input date string
 * @returns {string|null} Normalized "YYYY-MM-DD" or null if invalid
 */
function normalizeDate(str) {
  if (str === undefined || str === null || str === '') return '';
  if (typeof str !== 'string') str = String(str);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str.trim());
  if (!m) return null;
  const y = parseInt(m[1], 10), mo = parseInt(m[2], 10), d = parseInt(m[3], 10);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const daysInMonth = new Date(y, mo, 0).getDate();
  if (d > daysInMonth) return null;
  return y + '-' + String(mo).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}

// ─── Math utilities ──────────────────────────────────────────────────────

/**
 * Clamp a value to [lo, hi] range and round to integer.
 * @param {number} v - Value to clamp
 * @param {number} [lo=0] - Lower bound
 * @param {number} [hi=100] - Upper bound
 * @returns {number} Clamped and rounded value
 */
function clamp(v, lo, hi) {
  lo = lo === undefined ? 0 : lo;
  hi = hi === undefined ? 100 : hi;
  return Math.max(lo, Math.min(hi, Math.round(v)));
}

module.exports = {
  genId,
  todayStr,
  daysBetween,
  normalizeTime,
  normalizeDate,
  clamp,
};
