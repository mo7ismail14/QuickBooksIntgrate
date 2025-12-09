require("dotenv").config();
const express = require("express");
const OAuthClient = require("intuit-oauth");
const axios = require("axios");

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

// -----------------------------------------
// HELPER: GET QUICKBOOKS API URL
// -----------------------------------------
const getApiUrl = () => {
  const env = process.env.ENVIRONMENT || "sandbox";
  return env === "production"
    ? "https://quickbooks.api.intuit.com"
    : "https://sandbox-quickbooks.api.intuit.com";
};

// -----------------------------------------
// HELPER: MAKE AUTHENTICATED REQUEST
// -----------------------------------------
const makeQBRequest = async (method, endpoint, data = null) => {
  try {
    const url = `${getApiUrl()}/v3/company/${realmId}/${endpoint}`;
    const config = {
      method,
      url,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
    };

    if (data) config.data = data;

    const response = await axios(config);
    return response.data;
  } catch (error) {
    if (error.response?.status === 401) {
      // Token expired, try to refresh
      await refreshAccessToken();
      return makeQBRequest(method, endpoint, data);
    }
    throw error;
  }
};

// -----------------------------------------
// HELPER: REFRESH ACCESS TOKEN
// -----------------------------------------
const refreshAccessToken = async () => {
  try {
    const authResponse = await oauthClient.refresh();
    const t = authResponse.getToken();
    accessToken = t.access_token;
    refreshToken = t.refresh_token;
    console.log("Access token refreshed successfully");
  } catch (error) {
    console.error("Failed to refresh token:", error.message);
    throw error;
  }
};

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

    res.send(`
      <h1>Connected to QuickBooks!</h1>
      <p>Realm ID: ${realmId}</p>
      <ul>
        <li><a href="/api/employees">View Employees</a></li>
        <li><a href="/api/time-activities">View Time Activities</a></li>
      </ul>
    `);
  } catch (e) {
    res.status(500).send(e.message);
  }
});

// -----------------------------------------
// EMPLOYEE ENDPOINTS
// -----------------------------------------

// Get all employees
app.get("/api/employees", async (req, res) => {
  try {
    const data = await makeQBRequest("GET", "query?query=SELECT * FROM Employee");
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get single employee by ID
app.get("/api/employees/:id", async (req, res) => {
  try {
    const data = await makeQBRequest("GET", `employee/${req.params.id}`);
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create new employee
app.post("/api/employees", async (req, res) => {
  try {
    const { givenName, familyName, email, phone, address } = req.body;

    const employee = {
      GivenName: givenName,
      FamilyName: familyName,
      DisplayName: `${givenName} ${familyName}`,
      PrimaryEmailAddr: email ? { Address: email } : undefined,
      PrimaryPhone: phone ? { FreeFormNumber: phone } : undefined,
      PrimaryAddr: address ? {
        Line1: address.line1,
        City: address.city,
        CountrySubDivisionCode: address.state,
        PostalCode: address.postalCode,
        Country: address.country || "US"
      } : undefined
    };

    const data = await makeQBRequest("POST", "employee", employee);
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message, details: error.response?.data });
  }
});

// Update employee
app.put("/api/employees/:id", async (req, res) => {
  try {
    // First, get the current employee data to get SyncToken
    const currentEmployee = await makeQBRequest("GET", `employee/${req.params.id}`);

    const { givenName, familyName, email, phone, address } = req.body;

    const updatedEmployee = {
      ...currentEmployee.Employee,
      GivenName: givenName || currentEmployee.Employee.GivenName,
      FamilyName: familyName || currentEmployee.Employee.FamilyName,
      DisplayName: `${givenName || currentEmployee.Employee.GivenName} ${familyName || currentEmployee.Employee.FamilyName}`,
      PrimaryEmailAddr: email ? { Address: email } : currentEmployee.Employee.PrimaryEmailAddr,
      PrimaryPhone: phone ? { FreeFormNumber: phone } : currentEmployee.Employee.PrimaryPhone,
      PrimaryAddr: address ? {
        Line1: address.line1,
        City: address.city,
        CountrySubDivisionCode: address.state,
        PostalCode: address.postalCode,
        Country: address.country || "US"
      } : currentEmployee.Employee.PrimaryAddr,
      sparse: true
    };

    const data = await makeQBRequest("POST", "employee", updatedEmployee);
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message, details: error.response?.data });
  }
});

// Delete employee endpoint
app.delete("/api/employees/:id", async (req, res) => {
  try {
    // First, get the current employee data to get SyncToken
    const currentEmployee = await makeQBRequest("GET", `employee/${req.params.id}`);

    // QuickBooks requires SyncToken for delete operations
    const deletePayload = {
      Id: req.params.id,
      SyncToken: currentEmployee.Employee.SyncToken
    };

    // Use POST with operation=delete query parameter
    const data = await makeQBRequest("POST", `employee?operation=delete`, deletePayload);
    
    res.json({ 
      success: true, 
      message: "Employee deleted successfully",
      data 
    });
  } catch (error) {
    res.status(500).json({ 
      error: error.message, 
      details: error.response?.data 
    });
  }
});

// -----------------------------------------
// TIME ACTIVITY ENDPOINTS
// -----------------------------------------

// Get all time activities
app.get("/api/time-activities", async (req, res) => {
  try {
    const data = await makeQBRequest("GET", "query?query=SELECT * FROM TimeActivity");
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get time activities by employee
app.get("/api/time-activities/employee/:employeeId", async (req, res) => {
  try {
    const query = `SELECT * FROM TimeActivity WHERE EmployeeRef = '${req.params.employeeId}'`;
    const data = await makeQBRequest("GET", `query?query=${encodeURIComponent(query)}`);
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create time activity - traditional with hours/minutes
app.post("/api/time-activities", async (req, res) => {
  try {

    // Send the time activity object to QuickBooks API
    const data = await makeQBRequest("POST", "timeactivity", req.body.timeActivity);

    // Respond with the result from the QuickBooks API
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message, details: error.response?.data });
  }
});


// Clock-in: Create a new time activity with start time and temporary end time
app.post("/api/time-activities/clock-in", async (req, res) => {
  try {
    const { employeeId, clockIn, description, customerId, itemId } = req.body;

    if (!employeeId) {
      return res.status(400).json({ error: "employeeId is required" });
    }

    const now = new Date();
    const date = now.toISOString().split('T')[0]; // YYYY-MM-DD
    const startTime = clockIn || now.toTimeString().split(' ')[0]; // HH:MM:SS

    // Set EndTime to same as StartTime temporarily (will update on clock-out)
    const endTime = startTime;

    const timeActivity = {
      NameOf: "Employee",
      EmployeeRef: {
        value: employeeId
      },
      TxnDate: date,
      StartTime: startTime,
      EndTime: endTime, // QuickBooks requires both times - set equal initially
      Hours: 0,
      Minutes: 0,
      Description: description || "⏱️ Clocked in - Active",
      ...(customerId && {
        CustomerRef: {
          value: customerId
        }
      }),
      ...(itemId && {
        ItemRef: {
          value: itemId
        }
      })
    };

    const data = await makeQBRequest("POST", "timeactivity", timeActivity);
    res.json({
      success: true,
      message: "Clocked in successfully",
      timeActivityId: data.TimeActivity.Id,
      clockIn: startTime,
      status: "active",
      note: "Clock out to complete this time entry",
      data
    });
  } catch (error) {
    res.status(500).json({ error: error.message, details: error.response?.data });
  }
});

// Clock-out: Update existing time activity with actual end time
app.post("/api/time-activities/clock-out/:id", async (req, res) => {
  try {
    const { clockOut } = req.body;

    // Get current time activity
    const currentActivity = await makeQBRequest("GET", `timeactivity/${req.params.id}`);

    if (!currentActivity.TimeActivity.StartTime) {
      return res.status(400).json({
        error: "This time activity doesn't have a clock-in time"
      });
    }

    // Check if already properly clocked out (StartTime != EndTime and Hours > 0)
    const isClockedOut = currentActivity.TimeActivity.StartTime !== currentActivity.TimeActivity.EndTime &&
      (currentActivity.TimeActivity.Hours > 0 || currentActivity.TimeActivity.Minutes > 0);

    if (isClockedOut) {
      return res.status(400).json({
        error: "Already clocked out",
        clockIn: currentActivity.TimeActivity.StartTime,
        clockOut: currentActivity.TimeActivity.EndTime,
        hours: currentActivity.TimeActivity.Hours,
        minutes: currentActivity.TimeActivity.Minutes
      });
    }

    const now = new Date();
    const endTime = clockOut || now.toTimeString().split(' ')[0]; // HH:MM:SS

    // Calculate hours and minutes from StartTime to EndTime
    const start = new Date(`1970-01-01T${currentActivity.TimeActivity.StartTime}`);
    const end = new Date(`1970-01-01T${endTime}`);
    let diffMs = end - start;

    // Handle clock-out on next day (if end time is earlier than start time)
    if (diffMs < 0) {
      diffMs += 24 * 60 * 60 * 1000; // Add 24 hours
    }

    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffMinutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));

    const updatedActivity = {
      ...currentActivity.TimeActivity,
      EndTime: endTime,
      Hours: diffHours,
      Minutes: diffMinutes,
      Description: currentActivity.TimeActivity.Description.replace("⏱️ Clocked in - Active", "✅ Completed"),
      sparse: true
    };

    const data = await makeQBRequest("POST", "timeactivity", updatedActivity);
    res.json({
      success: true,
      message: "Clocked out successfully",
      clockIn: currentActivity.TimeActivity.StartTime,
      clockOut: endTime,
      totalHours: diffHours,
      totalMinutes: diffMinutes,
      totalTime: `${diffHours}h ${diffMinutes}m`,
      data
    });
  } catch (error) {
    res.status(500).json({ error: error.message, details: error.response?.data });
  }
});

// Get active clock-in (time activities where StartTime == EndTime and Hours == 0)
app.get("/api/time-activities/active/:employeeId", async (req, res) => {
  try {
    const query = `SELECT * FROM TimeActivity WHERE EmployeeRef = '${req.params.employeeId}'`;
    const data = await makeQBRequest("GET", `query?query=${encodeURIComponent(query)}`);

    // Filter for active clock-ins (StartTime == EndTime means still clocked in)
    const activeActivities = data.QueryResponse.TimeActivity?.filter(
      activity => activity.StartTime &&
        activity.EndTime &&
        activity.StartTime === activity.EndTime &&
        (activity.Hours === 0 || !activity.Hours)
    ) || [];

    res.json({
      hasActiveClockIn: activeActivities.length > 0,
      activeTimeActivities: activeActivities,
      count: activeActivities.length
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update time activity
app.put("/api/time-activities/:id", async (req, res) => {
  try {
    // Get current time activity for SyncToken
    const currentActivity = await makeQBRequest("GET", `timeactivity/${req.params.id}`);

    const { date, hours, minutes, description, customerId, itemId } = req.body;

    const updatedActivity = {
      ...currentActivity.TimeActivity,
      TxnDate: date || currentActivity.TimeActivity.TxnDate,
      Hours: hours !== undefined ? hours : currentActivity.TimeActivity.Hours,
      Minutes: minutes !== undefined ? minutes : currentActivity.TimeActivity.Minutes,
      Description: description || currentActivity.TimeActivity.Description,
      ...(customerId && {
        CustomerRef: {
          value: customerId
        }
      }),
      ...(itemId && {
        ItemRef: {
          value: itemId
        }
      }),
      sparse: true
    };

    const data = await makeQBRequest("POST", "timeactivity", updatedActivity);
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message, details: error.response?.data });
  }
});

// Delete time activity
app.delete("/api/time-activities/:id", async (req, res) => {
  try {
    const currentActivity = await makeQBRequest("GET", `timeactivity/${req.params.id}`);

    const deletePayload = {
      Id: req.params.id,
      SyncToken: currentActivity.TimeActivity.SyncToken
    };

    const data = await makeQBRequest("POST", `timeactivity?operation=delete`, deletePayload);
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ error: error.message, details: error.response?.data });
  }
});

// -----------------------------------------
// UTILITY ENDPOINTS
// -----------------------------------------

// Get customers (for time activity references)
app.get("/api/customers", async (req, res) => {
  try {
    const data = await makeQBRequest("GET", "query?query=SELECT * FROM Customer");
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get service items (for time activity references)
app.get("/api/items", async (req, res) => {
  try {
    const data = await makeQBRequest("GET", "query?query=SELECT * FROM Item WHERE Type='Service'");
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// -----------------------------------------
// START SERVER
// -----------------------------------------
app.listen(port, () => {
  console.log(`Server running → http://localhost:${port}`);
  console.log(`\nAvailable endpoints:`);
  console.log(`  GET  /auth - Start OAuth flow`);
  console.log(`  GET  /api/employees - List all employees`);
  console.log(`  GET  /api/employees/:id - Get employee by ID`);
  console.log(`  POST /api/employees - Create employee`);
  console.log(`  PUT  /api/employees/:id - Update employee`);
  console.log(`  GET  /api/time-activities - List all time activities`);
  console.log(`  GET  /api/time-activities/employee/:employeeId - Get time activities by employee`);
  console.log(`  GET  /api/time-activities/active/:employeeId - Get active clock-in (no clock-out yet)`);
  console.log(`  POST /api/time-activities - Create time activity`);
  console.log(`  POST /api/time-activities/clock-in - Clock in (start time only)`);
  console.log(`  POST /api/time-activities/clock-out/:id - Clock out (add end time)`);
  console.log(`  PUT  /api/time-activities/:id - Update time activity`);
  console.log(`  DELETE /api/time-activities/:id - Delete time activity`);
});