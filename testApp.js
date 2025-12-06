require("dotenv").config();
const ExcelJS = require("exceljs");
const moment = require("moment");
const express = require("express");
const OAuthClient = require("intuit-oauth");

const app = express();
app.use(express.json());

const port = process.env.PORT || 3000;

// -----------------------------------------
// 1. INITIALIZE OAUTH CLIENT
// -----------------------------------------
const oauthClient = new OAuthClient({
    clientId: process.env.CLIENT_ID,
    clientSecret: process.env.CLIENT_SECRET,
    redirectUri: process.env.REDIRECT_URI,
    environment: process.env.ENVIRONMENT || "sandbox",
});

let accessToken = process.env.ACCESSTOKEN || null;
let refreshToken = process.env.REFRESHTOKEN || null;
let realmId = process.env.REALMID || null;

// In-memory storage
const timeEntries = new Map(); // employeeId -> array of entries

// -----------------------------------------
// AUTH FLOW
// -----------------------------------------
app.get("/auth", (req, res) => {
    const authUrl = oauthClient.authorizeUri({
        scope: [OAuthClient.scopes.Accounting, OAuthClient.scopes.OpenId],
        state: "test123",
    });
    res.redirect(authUrl);
});

app.get("/api/quickbooks/callback", async (req, res) => {
    try {
        const token = await oauthClient.createToken(req.originalUrl);
        const t = token.getToken();
        accessToken = t.access_token;
        refreshToken = t.refresh_token;
        realmId = t.realmId;

        res.send(`<h1>Connected to QuickBooks!</h1><p>Realm ID: ${realmId}</p><a href="/test">Go to Test Panel</a>`);
    } catch (e) {
        res.status(500).send(e.message);
    }
});

// -----------------------------------------
// CLOCK IN
// -----------------------------------------
app.post("/api/clock-in", (req, res) => {
    const { employeeId, employeeName, location, notes } = req.body;
    if (!employeeId || !employeeName) return res.status(400).json({ error: "employeeId & employeeName required" });

    let entries = timeEntries.get(employeeId) || [];
    if (entries.some(e => !e.clockOut)) {
        return res.status(400).json({ error: "Already clocked in" });
    }

    const entry = {
        id: `${employeeId}_${Date.now()}`,
        employeeId,
        employeeName,
        clockIn: new Date().toISOString(),
        clockOut: null,
        location: location || "Office",
        notes: notes || "",
        totalHours: 0,
        totalMinutes: 0,
        status: "active",
        syncedToQB: false
    };

    entries.push(entry);
    timeEntries.set(employeeId, entries);

    res.json({ success: true, message: "Clocked in!", entry });
});

// -----------------------------------------
// CLOCK OUT
// -----------------------------------------
app.post("/api/clock-out", (req, res) => {
    const { employeeId, notes } = req.body;
    if (!employeeId) return res.status(400).json({ error: "employeeId required" });

    const entries = timeEntries.get(employeeId) || [];
    const active = entries.find(e => !e.clockOut);
    if (!active) return res.status(400).json({ error: "Not clocked in" });

    const clockOutTime = new Date();
    const diffMs = clockOutTime - new Date(active.clockIn);
    const diffMins = Math.floor(diffMs / 60000);
    const hours = Math.floor(diffMins / 60);
    const minutes = diffMins % 60;

    active.clockOut = clockOutTime.toISOString();
    active.totalHours = hours;
    active.totalMinutes = minutes;
    active.status = "completed";
    if (notes) active.notes += " | Out: " + notes;

    res.json({
        success: true,
        message: "Clocked out!",
        timeWorked: `${hours}h ${minutes}m`,
        entry: active
    });
});

// -----------------------------------------
// STATUS
// -----------------------------------------
app.get("/api/status/:employeeId", (req, res) => {
    const entries = timeEntries.get(req.params.employeeId) || [];
    const active = entries.find(e => !e.clockOut);

    if (active) {
        const diffMs = Date.now() - new Date.parse(active.clockIn);
        const diffMins = Math.floor(diffMs / 60000);
        const h = Math.floor(diffMins / 60);
        const m = diffMins % 60;
        return res.json({
            status: "clocked_in",
            currentDuration: `${h}h ${m}m`,
            entry: active
        });
    }

    res.json({ status: "clocked_out", lastEntry: entries[entries.length - 1] || null });
});

// -----------------------------------------
// FIXED & IMPROVED EXCEL EXPORT (Single Employee)
// -----------------------------------------
app.get("/api/export/excel/:employeeId", async (req, res) => {
    try {
        const { employeeId } = req.params;
        const { startDate, endDate } = req.query;

        let entries = timeEntries.get(employeeId) || [];

        // Optional date filter
        if (startDate) entries = entries.filter(e => new Date(e.clockIn) >= new Date(startDate));
        if (endDate) entries = entries.filter(e => e.clockOut && new Date(e.clockOut) <= new Date(endDate));

        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet("Time Report");

        sheet.columns = [
            { header: "Date", key: "date", width: 12 },
            { header: "Employee", key: "employee", width: 20 },
            { header: "Clock In", key: "clockIn", width: 20 },
            { header: "Clock Out", key: "clockOut", width: 20 },
            { header: "Hours", key: "hours", width: 10 },
            { header: "Minutes", key: "minutes", width: 10 },
            { header: "Total Time", key: "totalTime", width: 15 },
            { header: "Location", key: "location", width: 15 },
            { header: "Notes", key: "notes", width: 35 },
            { header: "Synced", key: "synced", width: 12 }
        ];

        // Header style
        const headerRow = sheet.getRow(1);
        headerRow.font = { bold: true, color: { argb: "FFFFFFFF" } };
        headerRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF4472C4" } };

        let totalMins = 0;

        entries.forEach(entry => {
            let h, m, clockOutDisplay;

            if (entry.clockOut) {
                // Completed shift
                h = entry.totalHours;
                m = entry.totalMinutes;
                clockOutDisplay = moment(entry.clockOut).format("YYYY-MM-DD HH:mm:ss");
            } else {
                // Still active → live calculation
                const diff = Date.now() - Date.parse(entry.clockIn);
                const liveMins = Math.floor(diff / 60000);
                h = Math.floor(liveMins / 60);
                m = liveMins % 60;
                clockOutDisplay = "ACTIVE NOW";
            }

            totalMins += (h * 60 + m);

            sheet.addRow({
                date: moment(entry.clockIn).format("YYYY-MM-DD"),
                employee: entry.employeeName,
                clockIn: moment(entry.clockIn).format("YYYY-MM-DD HH:mm:ss"),
                clockOut: clockOutDisplay,
                hours: h,
                minutes: m,
                totalTime: `${h}h ${m}m`,
                location: entry.location,
                notes: entry.notes,
                synced: entry.syncedToQB ? "Yes" : "No"
            });
        });

        // TOTAL ROW
        const totalH = Math.floor(totalMins / 60);
        const totalM = totalMins % 60;
        sheet.addRow({}); // empty row
        const totalRow = sheet.addRow({
            date: "TOTAL",
            totalTime: `${totalH}h ${totalM}m`,
            hours: totalH,
            minutes: totalM
        });
        totalRow.font = { bold: true };
        totalRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8F5E8" } };

        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        res.setHeader("Content-Disposition", `attachment; filename=TimeReport_${employeeId}_${moment().format("YYYYMMDD_HHmm")}.xlsx`);

        await workbook.xlsx.write(res);
        res.end();
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// -----------------------------------------
// EXPORT ALL EMPLOYEES (Also Fixed)
// -----------------------------------------
app.get("/api/export/all-employees", async (req, res) => {
    try {
        const { startDate, endDate } = req.query;
        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet("All Employees");

        sheet.columns = [
            { header: "Emp ID", key: "id", width: 12 },
            { header: "Employee", key: "name", width: 22 },
            { header: "Date", key: "date", width: 12 },
            { header: "Clock In", key: "in", width: 20 },
            { header: "Clock Out", key: "out", width: 20 },
            { header: "Duration", key: "dur", width: 15 },
            { header: "Location", key: "loc", width: 15 },
            { header: "Status", key: "status", width: 12 }
        ];

        sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
        sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF4472C4" } };

        for (const [empId, entries] of timeEntries) {
            let list = entries;
            if (startDate) list = list.filter(e => new Date(e.clockIn) >= new Date(startDate));
            if (endDate) list = list.filter(e => e.clockOut && new Date(e.clockOut) <= new Date(endDate));

            list.forEach(entry => {
                let duration = "";
                if (entry.clockOut) {
                    duration = `${entry.totalHours}h ${entry.totalMinutes}m`;
                } else {
                    const diff = Date.now() - Date.parse(entry.clockIn);
                    const m = Math.floor(diff / 60000);
                    duration = `${Math.floor(m/60)}h ${m%60}m (LIVE)`;
                }

                sheet.addRow({
                    id: entry.employeeId,
                    name: entry.employeeName,
                    date: moment(entry.clockIn).format("YYYY-MM-DD"),
                    in: moment(entry.clockIn).format("HH:mm:ss"),
                    out: entry.clockOut ? moment(entry.clockOut).format("HH:mm:ss") : "● Active",
                    dur: duration,
                    loc: entry.location,
                    status: entry.status === "completed" ? "Completed" : "Active"
                });
            });
        }

        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        res.set("Content-Disposition", `attachment; filename=All_Employees_${moment().format("YYYYMMDD_HHmm")}.xlsx`);
        await workbook.xlsx.write(res);
        res.end();
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// -----------------------------------------
// 10. DASHBOARD DATA
// -----------------------------------------
app.get("/api/dashboard", (req, res) => {
    try {
        const stats = {
            totalEmployees: timeEntries.size,
            activeNow: 0,
            todayEntries: 0,
            employees: []
        };

        const today = moment().startOf("day");

        for (const [employeeId, entries] of timeEntries) {
            const activeEntry = entries.find(e => !e.clockOut);
            const todayEntries = entries.filter(e => 
                moment(e.clockIn).isSameOrAfter(today)
            );

            if (activeEntry) stats.activeNow++;
            stats.todayEntries += todayEntries.length;

            const totalHours = entries.reduce((sum, e) => sum + e.totalHours, 0);
            const totalMinutes = entries.reduce((sum, e) => sum + e.totalMinutes, 0);

            stats.employees.push({
                employeeId,
                employeeName: entries[0]?.employeeName || "Unknown",
                status: activeEntry ? "active" : "offline",
                totalEntries: entries.length,
                totalTime: `${totalHours}h ${totalMinutes}m`,
                lastActivity: entries[entries.length - 1]?.clockIn
            });
        }

        res.json(stats);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// -----------------------------------------
// TEST ENDPOINT - Quick Test Panel (Development Only)
// -----------------------------------------
app.get("/test", (req, res) => {
  res.send(`
    <!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="UTF-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
          <title>Time Tracker - Quick Test Panel</title>
          <style>
            body { font-family: Arial, sans-serif; padding: 20px; background: #f4f6f9; }
            .container { max-width: 900px; margin: 0 auto; background: white; padding: 30px; border-radius: 10px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
            h1 { color: #2c3e50; text-align: center; }
            .section { margin: 25px 0; padding: 20px; background: #f8f9fa; border-radius: 8px; }
            input, button, select { padding: 10px; margin: 8px 4px; font-size: 16px; border-radius: 5px; border: 1px solid #ccc; }
            button { background: #3498db; color: white; cursor: pointer; border: none; width: 150px; }
            button:hover { background: #2980b9; }
            button.danger { background: #e74c5c5; }
            button.success { background: #27ae60; }
            .result { margin-top: 15px; padding: 15px; background: #eef; border-radius: 5px; white-space: pre-wrap; font-family: monospace; }
            .actions { display: flex; flex-wrap: wrap; gap: 10px; }
            .employee-select { width: 200px; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>Time Tracking Test Panel</h1>
            <p><strong>Warning: Development Only</strong> – Use this only in testing environment!</p>

            <div class="section">
              <h2>1. Clock In</h2>
              <div class="actions">
                <input type="text" id="inId" placeholder="Employee ID (e.g. 101)" value="101"/>
                <input type="text" id="inName" placeholder="Employee Name" value="John Doe"/>
                <input type="text" id="inLoc" placeholder="Location (optional)" value="Office"/>
                <input type="text" id="inNotes" placeholder="Notes (optional)"/>
                <button onclick="clockIn()">Clock In</button>
              </div>
              <div id="inResult" class="result"></div>
            </div>

            <div class="section">
              <h2>2. Clock Out</h2>
              <div class="actions">
                <input type="text" id="outId" placeholder="Employee ID" value="101"/>
                <input type="text" id="outNotes" placeholder="Clock-out notes (optional)"/>
                <button class="danger" onclick="clockOut()">Clock Out</button>
              </div>
              <div id="outResult" class="result"></div>
            </div>

            <div class="section">
              <h2>3. Check Status</h2>
              <input type="text" id="statusId" placeholder="Employee ID" value="101"/>
              <button onclick="checkStatus()">Get Status</button>
              <div id="statusResult" class="result"></div>
            </div>

            <div class="section">
              <h2>4. Export Report (Excel)</h2>
              <div class="actions">
                <input type="text" id="exportId" placeholder="Employee ID (leave empty for all)" />
                <input type="date" id="startDate" placeholder="Start Date"/>
                <input type="date" id="endDate" placeholder="End Date"/>
                <button class="success" onclick="exportReport()">Download Excel Report</button>
              </div>
              <p><small>Leave Employee ID empty → exports all employees</small></p>
            </div>

            <div class="section">
              <h2>5. Quick Dashboard</h2>
              <button onclick="loadDashboard()">Load Dashboard Stats</button>
              <div id="dashResult" class="result"></div>
            </div>
          </div>

  <script>
    async function clockIn() {
      const res = await fetch("/api/clock-in", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          employeeId: document.getElementById("inId").value,
          employeeName: document.getElementById("inName").value,
          location: document.getElementById("inLoc").value || "Office",
          notes: document.getElementById("inNotes").value
        })
      });
      const data = await res.json();
      document.getElementById("inResult").textContent = JSON.stringify(data, null, 2);
    }

    async function clockOut() {
      const res = await fetch("/api/clock-out", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          employeeId: document.getElementById("outId").value,
          notes: document.getElementById("outNotes").value
        })
      });
      const data = await res.json();
      document.getElementById("outResult").textContent = JSON.stringify(data, null, 2);
    }

    async function checkStatus() {
      const id = document.getElementById("statusId").value;
      const res = await fetch(\`/api/status/\${id}\`);
      const data = await res.json();
      document.getElementById("statusResult").textContent = JSON.stringify(data, null, 2);
    }

    function exportReport() {
      const id = document.getElementById("exportId").value;
      let url = id 
        ? \`/api/export/excel/\${id}\` 
        : "/api/export/all-employees";

      const params = new URLSearchParams();
      if (document.getElementById("startDate").value) params.append("startDate", document.getElementById("startDate").value);
      if (document.getElementById("endDate").value) params.append("endDate", document.getElementById("endDate").value);

      if (params.toString()) url += \`?\${params}\`;

      window.location.href = url; // Triggers download
    }

    async function loadDashboard() {
      const res = await fetch("/api/dashboard");
      const data = await res.json();
      document.getElementById("dashResult").textContent = JSON.stringify(data, null, 2);
    }
  </script>
</body>
</html>
  `);
});


app.listen(port, () => {
    console.log(`Server running → http://localhost:${port}`);
    console.log(`Test Panel    → http://localhost:${port}/test`);
});