const OAuthClient = require('intuit-oauth');
const fs = require("fs");
const axios = require('axios');
const path = require('path');

const oauthClient = require("./qbClient");
const {parsePhoneNumber} = require('../utils/phoneNumber');
const { 
    calculateHours, 
    formatTime, 
    formatDateForQuickBooks,
    formatTimeForQuickBooks 
} = require('../utils/time');

// ✅ TOKEN FILE PATH - Single file in root directory
const TOKEN_FILE = path.join(__dirname, '..', 'tokens.json');

// ✅ Load tokens on startup
let tokens = {};

function loadTokens() {
    try {
        if (fs.existsSync(TOKEN_FILE)) {
            const tokenData = fs.readFileSync(TOKEN_FILE, 'utf8');
            tokens = JSON.parse(tokenData);
            console.log('✅ Tokens loaded from file');
            console.log('Token expires at:', new Date(tokens.expires_at).toISOString());
        } else {
            console.log('⚠️ No existing tokens found - authentication required');
        }
    } catch (error) {
        console.error('❌ Error loading tokens:', error);
        tokens = {};
    }
}

// Load tokens when service starts
loadTokens();

// ✅ Save tokens function - overwrites single file
function saveTokens(newTokens) {
    tokens = newTokens;
    try {
        fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));
        console.log('✅ Tokens saved to file:', TOKEN_FILE);
        console.log('Token will expire at:', new Date(tokens.expires_at).toISOString());
    } catch (error) {
        console.error('❌ Error saving tokens:', error);
    }
}

// ✅ Refresh Token if Expired
async function getValidToken() {
    // Check if tokens exist
    if (!tokens.access_token) {
        throw new Error('Not authenticated with QuickBooks. Please visit /api/quickbooks/auth');
    }

    // Check if token is expired
    if (Date.now() >= tokens.expires_at) {
        console.log('🔄 Token expired, refreshing...');
        try {
            // Set the current tokens in the client before refreshing
            oauthClient.setToken({
                access_token: tokens.access_token,
                refresh_token: tokens.refresh_token,
                realmId: tokens.realmId
            });
            
            const authResponse = await oauthClient.refresh();
            const newTokens = {
                access_token: authResponse.token.access_token,
                refresh_token: authResponse.token.refresh_token,
                realmId: tokens.realmId,
                expires_at: Date.now() + (authResponse.token.expires_in * 1000)
            };
            saveTokens(newTokens);
            console.log('✅ Token refreshed successfully');
        } catch (error) {
            console.error('❌ Token refresh failed:', error);
            throw new Error('Token refresh failed. Please re-authenticate.');
        }
    }
    return tokens;
}

const CheckAuth = (req, res) => {
    try {
        const { scopes } = OAuthClient;

        const authUrl = oauthClient.authorizeUri({
            scope: [
                scopes.Accounting,
                scopes.Email,
                scopes.OpenId,
                scopes.Profile,
            ],
        });
        res.json({ authUrl: authUrl });
    } catch (error) {
        console.error('Error generating auth URL:', error);
        res.status(500).json({ error: 'Failed to generate auth URL' });
    }
}

// ✅ Updated callback handler with token saving
const OAuthCallbackHandler = async (req, res) => {
    try {
        const parseRedirect = req.url;
        const authResponse = await oauthClient.createToken(parseRedirect);

        const newTokens = {
            access_token: authResponse.token.access_token,
            refresh_token: authResponse.token.refresh_token,
            realmId: authResponse.token.realmId,
            expires_at: Date.now() + (authResponse.token.expires_in * 1000)
        };

        saveTokens(newTokens);
        console.log('✅ OAuth callback successful, tokens saved');

        res.sendFile('quickbooks-success.html', { root: './public' });
    } catch (error) {
        console.error('❌ Error in callback:', error);
        res.redirect(`/quickbooks-error.html?error=${encodeURIComponent(error.message)}`);
    }
} 

// Fetch Employees from QuickBooks
const GetEmployeesQuickBooks = async (req, res) => {
    try {
        const validTokens = await getValidToken();
        
        const companyId = validTokens.realmId;
        const url = `${oauthClient.environment === 'sandbox' 
            ? 'https://sandbox-quickbooks.api.intuit.com' 
            : 'https://quickbooks.api.intuit.com'}/v3/company/${companyId}/query`;

        const query = "SELECT * FROM Employee";
        
        const response = await axios.get(url, {
            params: { query, minorversion: 65 },
            headers: {
                'Authorization': `Bearer ${validTokens.access_token}`,
                'Accept': 'application/json',
                'Content-Type': 'application/json'
            }
        });

        const employees = response.data.QueryResponse.Employee || [];
        
        // Map Data for employees
        const mappedEmployees = employees.map((employee) => {
            const phoneData = parsePhoneNumber(employee.PrimaryPhone?.FreeFormNumber);
            const phoneNumber = phoneData ? phoneData.number : null;
            const countryCode = phoneData ? phoneData.code : null;

            return {
                first_name: employee?.GivenName || null,
                last_name: employee?.FamilyName || null,
                email: employee?.PrimaryEmailAddr?.Address || null,
                phone_number: phoneNumber || null,
                phone_code: countryCode || null,
                quickbooks_id: employee?.Id || null,
                sync_to_quickbooks: true
            }
        });

        // Ensure the file is saved in the root-level JsonFiles folder
        const filePath = path.resolve(__dirname, '..', 'JsonFiles', `employees_${new Date().getTime()}.json`);
        
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        fs.writeFileSync(filePath, JSON.stringify(employees, null, 2));

        res.json({
            success: true,
            employees: mappedEmployees,
            count: mappedEmployees.length
        });

    } catch (error) {
        console.error('Error fetching employees:', error.response?.data || error.message);
        res.status(500).json({ 
            error: 'Failed to fetch employees from QuickBooks',
            details: error.response?.data || error.message
        });
    }
}

// Import Employees to Your Database
const ImportEmployees = async (req, res) => {
    try {
        const { employees, companyId } = req.body;
        const endPointSupabase = process.env.supabaseUrl

        console.log("companyId", companyId);
        console.log("employees", employees);

        if (!employees || !Array.isArray(employees)) {
            return res.status(400).json({ error: 'Invalid employees data' });
        }

        axios.post(`${endPointSupabase}/employeeList/quickbooks`, {
            data: employees,
            company_id: companyId,
        });

        res.json({
            success: true,
            imported: employees.length,
            message: "Employees in Process of Importing will Arrive Notification After Insert It"
        });

    } catch (error) {
        console.error('Error importing employees:', error);
        res.status(500).json({ error: 'Failed to import employees' });
    }
}

// Update Employee Working Hours (Clock Out)
const UpdateEmployeeWorkingHours = async (req, res) => {
    try {
        const {
            employeeId,
            quickbooksId,
            clockInTime,
            clockOutTime,
            totalHours,
            date,
            companyId
        } = req.body;

        if (!quickbooksId || !clockInTime || !clockOutTime) {
            return res.status(400).json({
                error: 'Missing required fields: quickbooksId, clockInTime, clockOutTime'
            });
        }

        const validTokens = await getValidToken();
        const realmId = validTokens.realmId;

        const baseUrl = oauthClient.environment === 'sandbox'
            ? 'https://sandbox-quickbooks.api.intuit.com'
            : 'https://quickbooks.api.intuit.com';

        const formattedDate = date || formatDateForQuickBooks(clockInTime);
        const formattedStartTime = formatTimeForQuickBooks(clockInTime);
        const formattedEndTime = formatTimeForQuickBooks(clockOutTime);
        const hours = totalHours || calculateHours(clockInTime, clockOutTime);

        const timeActivityData = {
            NameOf: "Employee",
            EmployeeRef: {
                value: quickbooksId
            },
            TxnDate: formattedDate,
            StartTime: formattedStartTime,
            EndTime: formattedEndTime,
            Hours: hours,
            Description: `Clock In: ${formatTime(clockInTime)} - Clock Out: ${formatTime(clockOutTime)} | Employee ID: ${employeeId}`
        };

        console.log('Sending to QuickBooks:', timeActivityData);

        const response = await axios.post(
            `${baseUrl}/v3/company/${realmId}/timeactivity`,
            timeActivityData,
            {
                headers: {
                    'Authorization': `Bearer ${validTokens.access_token}`,
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                },
                params: { minorversion: 65 }
            }
        );

        const filePath = path.resolve(__dirname, '..', 'JsonFiles');
        if (!fs.existsSync(filePath)) {
            fs.mkdirSync(filePath, { recursive: true });
        }

        fs.writeFileSync(
            path.join(filePath, `timeactivity_${employeeId}_${new Date().getTime()}.json`),
            JSON.stringify(response.data, null, 2)
        );

        res.json({
            success: true,
            message: 'Working hours updated in QuickBooks',
            data: {
                timeActivityId: response.data.TimeActivity.Id,
                employeeId: employeeId,
                quickbooksId: quickbooksId,
                hours: hours,
                date: formattedDate,
                startTime: formattedStartTime,
                endTime: formattedEndTime
            }
        });

    } catch (error) {
        console.error('Error updating working hours:', error.response?.data || error);
        res.status(500).json({
            error: 'Failed to update working hours in QuickBooks',
            details: error.response?.data || error.message
        });
    }
}

// Check Connection Status
const CheckConnectionStatus = async (req, res) => {
    try {
        const isConnected = tokens.access_token && Date.now() < tokens.expires_at;
        res.json({ 
            connected: isConnected,
            expiresAt: tokens.expires_at ? new Date(tokens.expires_at).toISOString() : null,
            realmId: tokens.realmId || null
        });
    } catch (error) {
        res.json({ connected: false });
    }
}

// Disconnect QuickBooks
const DisconnectQuickBooks = async (req, res) => {
    try {
        await oauthClient.revoke();
        tokens = {};
        
        // Delete token file
        if (fs.existsSync(TOKEN_FILE)) {
            fs.unlinkSync(TOKEN_FILE);
            console.log('✅ Token file deleted');
        }
        
        res.json({ success: true, message: 'Disconnected from QuickBooks' });
    } catch (error) {
        console.error('Error disconnecting:', error);
        res.status(500).json({ error: 'Failed to disconnect' });
    }
}

module.exports = {
    CheckAuth,
    OAuthCallbackHandler,
    GetEmployeesQuickBooks,
    ImportEmployees,
    CheckConnectionStatus,
    DisconnectQuickBooks,
    UpdateEmployeeWorkingHours
};