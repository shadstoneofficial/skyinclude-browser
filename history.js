const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { app } = require('electron');

class HistoryManager {
    constructor(options = {}) {
        this.historyFile = options.historyFile || path.join(app.getPath('userData'), 'browsing-history.json');
        this.history = [];
        this.maxEntries = 1000;
        this.fileSystem = options.fileSystem || fs.promises;
        this.debounceMs = options.debounceMs ?? 150;
        this.onError = options.onError || (error => console.error('Failed to save history:', error));
        this.revision = 0;
        this.savedRevision = 0;
        this.saveTimer = null;
        this.writePromise = null;
        this.tempFile = `${this.historyFile}.tmp-${process.pid}-${randomUUID()}`;
        this.loadHistory();
    }

    loadHistory() {
        try {
            if (fs.existsSync(this.historyFile)) {
                const data = fs.readFileSync(this.historyFile, 'utf8');
                const entries = JSON.parse(data);
                this.history = Array.isArray(entries) ? entries.slice(0, this.maxEntries) : [];
                console.log(`Loaded ${this.history.length} history entries`);
            } else {
                console.log('No existing history file found, starting fresh');
                this.history = [];
            }
        } catch (error) {
            console.error('Failed to load history:', error);
            this.history = [];
        }
    }

    saveHistory() {
        this.revision += 1;
        if (this.saveTimer) clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => {
            this.saveTimer = null;
            void this.writePendingHistory();
        }, this.debounceMs);
        this.saveTimer.unref?.();
    }

    writePendingHistory() {
        if (this.writePromise) return this.writePromise;
        this.writePromise = this.drainHistoryWrites().then(success => {
            this.writePromise = null;
            if (success && this.savedRevision < this.revision) return this.writePendingHistory();
            return success;
        });
        return this.writePromise;
    }

    async drainHistoryWrites() {
        while (this.savedRevision < this.revision) {
            const writingRevision = this.revision;
            try {
                const snapshot = JSON.stringify(this.history, null, 2);
                await this.fileSystem.mkdir(path.dirname(this.historyFile), { recursive: true });
                await this.fileSystem.writeFile(this.tempFile, snapshot, { encoding: 'utf8', mode: 0o600 });
                await this.fileSystem.rename(this.tempFile, this.historyFile);
                this.savedRevision = writingRevision;
            } catch (error) {
                // Preserve the last complete file and retry the latest state on the next save/flush.
                await this.fileSystem.unlink(this.tempFile).catch(() => {});
                try { this.onError(error); } catch (_) { /* Error reporting must not crash navigation. */ }
                return false;
            }
        }
        return true;
    }

    async flush() {
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
            this.saveTimer = null;
        }
        let success;
        do {
            success = await this.writePendingHistory();
        } while (success && this.savedRevision < this.revision);
        if (success && this.saveTimer) {
            clearTimeout(this.saveTimer);
            this.saveTimer = null;
        }
        return success;
    }

    addEntry(url, title = '', timestamp = Date.now(), favicon = null) {
        // Skip internal URLs
        if (url.startsWith('skyinclude://') || url.startsWith('file://')) {
            return;
        }

        // Remove existing entry for this URL to avoid duplicates
        this.history = this.history.filter(entry => entry.url !== url);

        // Add new entry at the beginning
        const entry = {
            url: url,
            title: title || this.extractTitleFromUrl(url),
            timestamp: timestamp,
            visitCount: 1,
            favicon: typeof favicon === 'string' ? favicon : null
        };

        this.history.unshift(entry);

        // Limit history size
        if (this.history.length > this.maxEntries) {
            this.history = this.history.slice(0, this.maxEntries);
        }

        this.saveHistory();
        console.log('Added history entry');
    }

    extractTitleFromUrl(url) {
        try {
            const urlObj = new URL(url);
            return urlObj.hostname;
        } catch {
            return url.substring(0, 50) + (url.length > 50 ? '...' : '');
        }
    }

    getHistory(limit = 100) {
        return this.history.slice(0, limit);
    }

    searchHistory(query, limit = 50) {
        if (!query || query.trim() === '') {
            return this.getHistory(limit);
        }

        const lowerQuery = query.toLowerCase();
        const filtered = this.history.filter(entry => 
            entry.url.toLowerCase().includes(lowerQuery) ||
            entry.title.toLowerCase().includes(lowerQuery)
        );

        return filtered.slice(0, limit);
    }

    removeEntry(url) {
        const initialLength = this.history.length;
        this.history = this.history.filter(entry => entry.url !== url);
        
        if (this.history.length < initialLength) {
            this.saveHistory();
            console.log('Removed history entry');
            return true;
        }
        
        return false;
    }

    clearHistory() {
        this.history = [];
        this.saveHistory();
        console.log('History cleared');
    }

    clearOldEntries(daysToKeep = 30) {
        const cutoffTime = Date.now() - (daysToKeep * 24 * 60 * 60 * 1000);
        const initialLength = this.history.length;
        
        this.history = this.history.filter(entry => entry.timestamp > cutoffTime);
        
        if (this.history.length < initialLength) {
            this.saveHistory();
            console.log(`Cleared ${initialLength - this.history.length} old history entries`);
        }
    }

    getTopSites(limit = 10) {
        // Count visits per domain
        const domainCounts = {};
        
        this.history.forEach(entry => {
            try {
                const domain = new URL(entry.url).hostname;
                domainCounts[domain] = (domainCounts[domain] || 0) + entry.visitCount;
            } catch {
                // Skip invalid URLs
            }
        });

        // Sort by visit count
        const sortedDomains = Object.entries(domainCounts)
            .sort(([,a], [,b]) => b - a)
            .slice(0, limit);

        return sortedDomains.map(([domain, count]) => ({
            domain,
            visitCount: count,
            lastVisit: this.getLastVisitForDomain(domain)
        }));
    }

    getLastVisitForDomain(domain) {
        const domainEntries = this.history.filter(entry => {
            try {
                return new URL(entry.url).hostname === domain;
            } catch {
                return false;
            }
        });

        if (domainEntries.length > 0) {
            return Math.max(...domainEntries.map(entry => entry.timestamp));
        }
        
        return 0;
    }

    getHistoryByDate(date) {
        const startOfDay = new Date(date);
        startOfDay.setHours(0, 0, 0, 0);
        
        const endOfDay = new Date(date);
        endOfDay.setHours(23, 59, 59, 999);

        return this.history.filter(entry => 
            entry.timestamp >= startOfDay.getTime() && 
            entry.timestamp <= endOfDay.getTime()
        );
    }

    getHistoryStats() {
        const now = Date.now();
        const oneDayAgo = now - (24 * 60 * 60 * 1000);
        const oneWeekAgo = now - (7 * 24 * 60 * 60 * 1000);
        const oneMonthAgo = now - (30 * 24 * 60 * 60 * 1000);

        return {
            totalEntries: this.history.length,
            today: this.history.filter(entry => entry.timestamp > oneDayAgo).length,
            thisWeek: this.history.filter(entry => entry.timestamp > oneWeekAgo).length,
            thisMonth: this.history.filter(entry => entry.timestamp > oneMonthAgo).length,
            oldestEntry: this.history.length > 0 ? 
                Math.min(...this.history.map(entry => entry.timestamp)) : null,
            newestEntry: this.history.length > 0 ? 
                Math.max(...this.history.map(entry => entry.timestamp)) : null
        };
    }

    exportHistory(format = 'json') {
        try {
            if (format === 'json') {
                return JSON.stringify(this.history, null, 2);
            } else if (format === 'csv') {
                const header = 'URL,Title,Timestamp,Visit Count\n';
                const rows = this.history.map(entry => 
                    `"${entry.url}","${entry.title}","${new Date(entry.timestamp).toISOString()}","${entry.visitCount}"`
                ).join('\n');
                return header + rows;
            }
        } catch (error) {
            console.error('Failed to export history:', error);
            return null;
        }
    }

    importHistory(data, format = 'json') {
        try {
            let importedEntries = [];
            
            if (format === 'json') {
                importedEntries = JSON.parse(data);
            } else if (format === 'csv') {
                const lines = data.split('\n').slice(1); // Skip header
                importedEntries = lines.map(line => {
                    const [url, title, timestamp, visitCount] = line.split(',').map(field => 
                        field.replace(/^"|"$/g, '') // Remove quotes
                    );
                    return {
                        url,
                        title,
                        timestamp: new Date(timestamp).getTime(),
                        visitCount: parseInt(visitCount) || 1
                    };
                }).filter(entry => entry.url); // Filter out invalid entries
            }

            // Merge with existing history, avoiding duplicates
            const existingUrls = new Set(this.history.map(entry => entry.url));
            const newEntries = importedEntries.filter(entry => !existingUrls.has(entry.url));
            
            this.history = [...this.history, ...newEntries];
            
            // Sort by timestamp (newest first)
            this.history.sort((a, b) => b.timestamp - a.timestamp);
            
            // Limit history size
            if (this.history.length > this.maxEntries) {
                this.history = this.history.slice(0, this.maxEntries);
            }

            this.saveHistory();
            console.log(`Imported ${newEntries.length} new history entries`);
            return newEntries.length;
            
        } catch (error) {
            console.error('Failed to import history:', error);
            return 0;
        }
    }
}

// Create singleton instance
const historyManager = new HistoryManager();

module.exports = {
    HistoryManager,
    addEntry: (url, title, timestamp, favicon) => historyManager.addEntry(url, title, timestamp, favicon),
    getHistory: (limit) => historyManager.getHistory(limit),
    searchHistory: (query, limit) => historyManager.searchHistory(query, limit),
    removeEntry: (url) => historyManager.removeEntry(url),
    clearHistory: () => historyManager.clearHistory(),
    clearOldEntries: (days) => historyManager.clearOldEntries(days),
    getTopSites: (limit) => historyManager.getTopSites(limit),
    getHistoryByDate: (date) => historyManager.getHistoryByDate(date),
    getHistoryStats: () => historyManager.getHistoryStats(),
    exportHistory: (format) => historyManager.exportHistory(format),
    importHistory: (data, format) => historyManager.importHistory(data, format),
    flush: () => historyManager.flush()
};
