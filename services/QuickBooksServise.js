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
const TOKEN_FILE = path.join(__dirname, '..', 'token.json');

// ✅ Read tokens from file
function getTokensFromFile() {
    try {
        if (fs.existsSync(TOKEN_FILE)) {
            const tokenData = fs.readFileSync(TOKEN_FILE, 'utf8');
            const tokens = JSON.parse(tokenData);
            console.log('✅ Tokens loaded from file');
            return tokens;
        } else {
            console.log('⚠️ No token file found');
            return null;
        }
    } catch (error) {
        console.error('❌ Error reading tokens:', error);
        return null;
    }
}

// ✅ Save tokens to file
function saveTokensToFile(tokens) {
    try {
        // Ensure directory exists
        const dir = path.dirname(TOKEN_FILE);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        
        fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));
        console.log('✅ Tokens saved to:', TOKEN_FILE);
        console.log('Token expires at:', new Date(tokens.expires_at).toISOString());
        return true;
    } catch (error) {
        console.error('❌ Error saving tokens:', error);
        return false;
    }
}

// ✅ Delete/Empty token file
function deleteTokenFile() {
    try {
        if (fs.existsSync(TOKEN_FILE)) {
            fs.unlinkSync(TOKEN_FILE);
            console.log('✅ Token file deleted');
        }
        return true;
    } catch (error) {
        console.error('❌ Error deleting token file:', error);
        return false;
    }
}

// ✅ Get valid token (read from file and refresh if needed)
async function getValidToken() {
    let tokens = getTokensFromFile();
    
    // Check if tokens exist
    if (!tokens || !tokens.access_token) {
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
            
            saveTokensToFile(newTokens);
            console.log('✅ Token refreshed successfully');
            return newTokens;
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

// ✅ OAuth Callback - Save tokens to file
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

        const saved = saveTokensToFile(newTokens);
        
        if (saved) {
            console.log('✅ OAuth callback successful, tokens saved');
            res.sendFile('quickbooks-success.html', { root: './public' });
        } else {
            throw new Error('Failed to save tokens');
        }
    } catch (error) {
        console.error('❌ Error in callback:', error);
        res.redirect(`/quickbooks-error.html?error=${encodeURIComponent(error.message)}`);
    }
} 

// ✅ Fetch Employees - Read tokens from file
const GetEmployeesQuickBooks = async (req, res) => {
    try {
        console.log('📂 Reading tokens from file...');
        const validTokens = await getValidToken();
        
        console.log('✅ Valid tokens obtained');
        const companyId = validTokens.realmId;
        const url = `${oauthClient.environment === 'sandbox' 
            ? 'https://sandbox-quickbooks.api.intuit.com' 
            : 'https://quickbooks.api.intuit.com'}/v3/company/${companyId}/query`;

        const query = "SELECT * FROM Employee";
        
        console.log('📡 Fetching employees from QuickBooks...');
        const response = await axios.get(url, {
            params: { query, minorversion: 65 },
            headers: {
                'Authorization': `Bearer ${validTokens.access_token}`,
                'Accept': 'application/json',
                'Content-Type': 'application/json'
            }
        });

        const employees = response.data.QueryResponse.Employee || [];
        console.log(`✅ Found ${employees.length} employees`);
        
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

        // Save to JsonFiles folder for logging
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
        console.error('❌ Error fetching employees:', error.message);
        res.status(500).json({ 
            error: 'Failed to fetch employees from QuickBooks',
            details: error.message
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

// ✅ Check Connection Status - Read from file
const CheckConnectionStatus = async (req, res) => {
    try {
        const tokens = getTokensFromFile();
        
        if (!tokens || !tokens.access_token) {
            return res.json({ connected: false });
        }
        
        const isConnected = Date.now() < tokens.expires_at;
        res.json({ 
            connected: isConnected,
            expiresAt: tokens.expires_at ? new Date(tokens.expires_at).toISOString() : null,
            realmId: tokens.realmId || null
        });
    } catch (error) {
        res.json({ connected: false });
    }
}

// ✅ Disconnect QuickBooks - Delete token file
const DisconnectQuickBooks = async (req, res) => {
    try {
        const tokens = getTokensFromFile();
        
        if (tokens && tokens.access_token) {
            // Set token in client before revoking
            oauthClient.setToken({
                access_token: tokens.access_token,
                refresh_token: tokens.refresh_token,
                realmId: tokens.realmId
            });
            
            await oauthClient.revoke();
        }
        
        // Delete the token file
        deleteTokenFile();
        
        res.json({ success: true, message: 'Disconnected from QuickBooks' });
    } catch (error) {
        console.error('Error disconnecting:', error);
        // Even if revoke fails, delete the file
        deleteTokenFile();
        res.json({ success: true, message: 'Disconnected from QuickBooks (token file removed)' });
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