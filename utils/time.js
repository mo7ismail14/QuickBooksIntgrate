/**
 * Calculate hours between two timestamps
 * @param {string|Date} startTime - Start time
 * @param {string|Date} endTime - End time
 * @returns {number} Hours worked (decimal)
 */
function calculateHours(startTime, endTime) {
    const start = new Date(startTime);
    const end = new Date(endTime);
    const diffMs = end - start;
    const diffHours = diffMs / (1000 * 60 * 60);
    return parseFloat(diffHours.toFixed(2));
}

/**
 * Format timestamp to readable time
 * @param {string|Date} timestamp - Timestamp to format
 * @returns {string} Formatted time string
 */
function formatTime(timestamp) {
    const date = new Date(timestamp);
    return date.toLocaleTimeString('en-US', { 
        hour: '2-digit', 
        minute: '2-digit',
        hour12: true 
    });
}


/**
 * Format timestamp for QuickBooks API (HH:MM:SS format in 24-hour)
 * @param {string|Date} timestamp - Timestamp to format
 * @returns {string} Time in HH:MM:SS format
 */
function formatTimeForQuickBooks(timestamp) {
    const date = new Date(timestamp);
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    return `${hours}:${minutes}:${seconds}`;
}


/**
 * Format date for QuickBooks API (YYYY-MM-DD format)
 * @param {string|Date} date - Date to format
 * @returns {string} Date in YYYY-MM-DD format
 */
function formatDateForQuickBooks(date) {
    const d = new Date(date);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}


/**
 * Convert ISO timestamp to QuickBooks datetime format
 * @param {string} isoTimestamp - ISO 8601 timestamp
 * @returns {string} QuickBooks formatted datetime
 */
function convertToQuickBooksDateTime(isoTimestamp) {
    const date = new Date(isoTimestamp);
    return date.toISOString(); // QuickBooks accepts ISO 8601
}


module.exports = { 
    calculateHours, 
    formatTime,
    formatTimeForQuickBooks,
    formatDateForQuickBooks,
    convertToQuickBooksDateTime
};