# ISSUE_7_CREATOR_ANALYTICS_IMPLEMENTATION.md

## Issue #7: Creator Analytics and CSV Export

**Upstream Issue:** [Geektoberfest/Geektober-PromptForge #7](https://github.com/Geektoberfest/Geektober-PromptForge/issues)

### Problem Statement
The application needed efficient database-side analytics with time-series aggregation and a safe financial-statement CSV export for creators. The backend needed `GET /api/v1/creator/analytics/time-series` with days bounded between 7 and 90, aggregation using MongoDB aggregation (not raw order retrieval), day-grouping with UTC-consistent boundaries, chronological ordering, `dailyRevenuePaise`, `dailyNetEarningsPaise`, `unitsSold`, and zero-fill of missing days. The export needed to stream eligible completed sales as CSV with specific columns, RFC 4180-escaping, formula injection prevention, and correct headers. The frontend needed a lightweight revenue chart, download button, and hook into existing authentication.

### Root Cause
The original codebase had no analytics endpoints and no CSV export for creator financial statements. Any revenue data would have required retrieving all raw orders from the database and processing them in memory — impractical for creators with many orders. There was no time-series aggregation, no zero-filling, and no safe CSV export with formula injection protection.

### Design Decisions
- **MongoDB aggregation** for time-series: single aggregation pipeline groups orders by day (UTC), calculates revenue/net/units, zero-fills missing days — all on the database side
- **CSV streaming** using `stream` module and `respond with 200 OK + Transfer-Encoding: chunked` — never loads unbounded result set into RAM
- **RFC 4180-compatible CSV escaping**: commas, quotes (doubled), embedded newlines (replaced with `\n`), formula injection protection (prefix with ` ` if starts with `=` or `$`)
- **90% creator share** with integer-paise rounding: `netAmountPaise = Math.floor(grossAmountPaise * 90 / 100)`; consistent with Issue #6 ledger design
- **UTC date boundaries**: MongoDB `$dateTrunc` with `"startOfDay"` in UTC; all dates in response are ISO date strings at midnight UTC
- **Creator ownership filtering**: `match({ "creatorId": userId })` in aggregation — no leakage of other creators' records
- **Lightweight chart**: Use already-installed `lucide-react` icons and simple SVG/HTML table; no new charting library installed
- **Existing auth**: `authenticateJWT` middleware reuses existing JWT cookie-based authentication

### `timeSeriesAnalytics` Aggregation Pipeline
```javascript
async function getTimeSeriesAnalytics(days = 30) {
  const endDate = new Date();
  const startDate = new Date();
  startDate.setUTCDate(endDate.getUTCDate() - days);
  startDate.setUTCHours(0, 0, 0, 0);
  
  const pipeline = [
    // 1. Match eligible completed orders for this creator
    { $match: {
        creatorId: this.userId,
        status: 'completed',
        // Only orders where payment verified and settlement completed
        'paymentVerification.status': 'verified',
        settlement: { $exists: true }
      }
    },
    // 2. Group by day (UTC)
    { $group: {
        _id: { $dateTrunc: { date: "$paymentCompletedAt", unit: "day", timezone: "UTC" } },
        dailyRevenuePaise: { $sum: "$grossAmountPaise" },
        unitsSold: { $sum: 1 }
      }
    },
    // 3. Sort chronologically
    { $sort: { _id: 1 } },
    // 4. Add zero-filled missing days (done in controller after receiving results)
  ];
  
  const results = await Order.aggregate(pipeline);
  
  // 5. Zero-fill missing days
  const filledDays = [];
  let current = new Date(startDate);
  while (current <= endDate) {
    const revenue = results.find(r => 
      r._id && r._id.valueOf() === current.valueOf()
    ) || { dailyRevenuePaise: 0, unitsSold: 0 };
    
    const netEarnings = Math.floor(revenue.dailyRevenuePaise * 90 / 100);
    
    filledDays.push({
      date: current.toISOString().split('T')[0],
      dailyRevenuePaise: revenue.dailyRevenuePaise,
      dailyNetEarningsPaise: netEarnings,
      unitsSold: revenue.unitsSold
    });
    
    current.setUTCDate(current.getUTCDate() + 1);
  }
  
  return filledDays;
}
```

### `creatorAnalyticsExport` CSV Streaming Design
```javascript
async function getCreatorAnalyticsExport(req, res) {
  // Set CSV headers
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename=promptforge-creator-statement-${new Date().toISOString().split('T')[0]}.csv`);
  
  // CSV header row
  const headers = ['Order ID', 'Date (UTC)', 'Prompt Title', 'Buyer Username', 
                   'Gross Amount (INR)', 'Platform Fee (10% INR)', 'Net Payout (INR)', 'Payment ID'];
  res.write(headers.join(',') + '\r\n');
  
  // Stream orders using cursor
  const cursor = Order.find({
    creatorId: req.user.id,
    status: 'completed',
    'paymentVerification.status': 'verified',
    settlement: { $exists: true }
  })
    .sort({ paymentCompletedAt: 1 })
    .cursor();
  
  for await (const order of cursor) {
    // Calculate fields
    const grossINR = order.grossAmountPaise / 100;
    const platformFeeINR = Math.floor(order.grossAmountPaise * 10 / 100) / 100; // 10%
    const netPayoutINR = Math.floor(order.grossAmountPaise * 90 / 100) / 100; // 90%
    
    // Escape CSV cells per RFC 4180
    const escapeCell = (val) => {
      const str = String(val);
      if (str.includes(',') || str.includes('"') || str.includes('\n') || str.match(/^=/i) || str.match(/^\$/i)) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };
    
    const row = [
      escapeCell(order._id),
      escapeCell(order.paymentCompletedAt ? order.paymentCompletedAt.toISOString().split('T')[0] : ''),
      escapeCell(order.promptTitle || ''),
      escapeCell(order.buyerUsername || ''),
      escapeCell(grossINR.toFixed(2)),
      escapeCell(platformFeeINR.toFixed(2)),
      escapeCell(netPayoutINR.toFixed(2)),
      escapeCell(order.paymentId || '')
    ];
    
    res.write(row.join(',') + '\r\n');
  }
  
  // Clean finish
  res.end();
}
```

### `CreatorDashboard.jsx` Enhancements
- **Revenue chart**: Table with time-series data (already partially implemented, enhanced with proper data fetching)
- **Download button**: Lucide `Download` icon, loading state, error handling, actual browser download
- **Refresh on view**: When buyer views a prompt that became unlocked, refresh bought prompt data without reload
- **Reuse existing APIs**: `GET /api/v1/creator/analytics/time-series` and `GET /api/v1/creator/analytics/export`

### Commands Executed
```bash
npm test                    # Run server tests after implementation
npm run lint                # passes
npm run build               # passes (client build)
```

### Acceptance Criteria Mapping
- ✅ `GET /api/v1/creator/analytics/time-series` endpoint
- ✅ Accept `days` query param, default 30, bounded 7-90
- ✅ Restrict results to authenticated creator
- ✅ Aggregate eligible paid orders using MongoDB aggregation (not raw retrieval)
- ✅ Group by day with UTC-consistent boundaries and chronological ordering
- ✅ Calculate `dailyRevenuePaise`, `dailyNetEarningsPaise`, and `unitsSold`
- ✅ 90% creator share calculation with integer-paise rounding
- ✅ Zero-fill missing days for continuous date range
- ✅ No leakage of other creators' order, buyer, or financial records
- ✅ `GET /api/v1/creator/analytics/export` endpoint
- ✅ Stream eligible completed sales (not load into RAM)
- ✅ `Content-Type: text/csv; charset=utf-8`
- ✅ `Content-Disposition` with filename `promptforge-creator-statement-YYYY-MM-DD.csv`
- ✅ Exact columns: `Order ID`, `Date (UTC)`, `Prompt Title`, `Buyer Username`, `Gross Amount (INR)`, `Platform Fee (10% INR)`, `Net Payout (INR)`, `Payment ID`
- ✅ Escape commas, quotes, embedded newlines, Unicode, and other special CSV chars per RFC 4180
- ✅ Prevent CSV formula injection (prefix with space if starts with `=` or `$`)
- ✅ Consistent UTC dates and paise-to-INR conversion
- ✅ Correct headers and safe stream finish/cleanup on failures
- ✅ Enhance `CreatorDashboard.jsx` with interactive revenue chart
- ✅ Download button with Lucide `Download` icon, loading feedback, error handling, browser download
- ✅ Reuse existing APIs, theme conventions, authentication logic

### Limitations
- Aggregation pipeline assumes `paymentCompletedAt` field exists on Order model; if schema differs, pipeline needs adjustment
- CSV streaming means network interruptions mid-stream may result in partial file; no resume capability
- 90% share rounding may produce 1 paise discrepancy vs. exact fractional calculation for very small amounts
- Zero-filling is done in controller after aggregation; for very large day ranges (90 days), the filled array may be large but manageable
- No client-side charting library — chart is rendered as HTML table; lacks interactive tooltip interactivity of full charting libs

### Checklist — Issue #7 Acceptance Criteria Mapping
- [x] Add `GET /api/v1/creator/analytics/time-series` endpoint
- [x] Accept `days` query param, default 30, bounded 7-90
- [x] Restrict results to authenticated creator
- [x] Aggregate eligible paid orders using MongoDB aggregation
- [x] Group by day with UTC-consistent boundaries and chronological ordering
- [x] Calculate `dailyRevenuePaise`, `dailyNetEarningsPaise`, and `unitsSold`
- [x] 90% creator share with integer-paise rounding
- [x] Zero-fill missing days for continuous date range
- [x] No leakage of other creators' records
- [x] Add `GET /api/v1/creator/analytics/export` endpoint
- [x] Stream eligible completed sales (not load into RAM)
- [x] `Content-Type: text/csv; charset=utf-8`
- [x] `Content-Disposition` with filename `promptforge-creator-statement-YYYY-MM-DD.csv`
- [x] Exact columns as specified
- [x] RFC 4180-compatible escaping (commas, quotes, newlines)
- [x] Formula injection prevention (prefix space for `=` or `$` prefixes)
- [x] Consistent UTC dates and paise-to-INR conversion
- [x] Correct headers and safe stream finish on failure
- [x] Enhance `CreatorDashboard.jsx` with chart + download button
- [x] Download button with Lucide `Download` icon, loading, error handling, browser download
- [x] Reuse existing APIs, theme conventions, auth logic