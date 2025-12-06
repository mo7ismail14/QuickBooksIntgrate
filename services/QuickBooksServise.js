const OAuthClient = require('intuit-oauth');
const axios = require('axios');

const oauthClient = require("./qbClient");
const {parsePhoneNumber} = require('../utils/phoneNumber');
const { 
    calculateHours, 
    formatTime, 
    formatDateForQuickBooks,
    formatTimeForQuickBooks 
} = require('../utils/time');

const SUPABASE_URL = process.env.supabaseUrl;

// ✅ Get tokens from Supabase
async function getTokensFromSupabase(companyId) {
    try {
        console.log("compay_id",companyId);
        
        const response = await axios.get(`${SUPABASE_URL}/quickbooks/tokens/${companyId}`);

        if (response.data?.success && response.data?.data) {
            console.log('✅ Tokens loaded from Supabase');
            console.log("data====",response?.data?.data);
            return response?.data?.data;
        }
        
        console.log('⚠️ No tokens found in Supabase');
        return null;
    } catch (error) {
        console.error('❌ Error reading tokens from Supabase:', error.message);
        return null;
    }
}

// ✅ Save tokens to Supabase
async function saveTokensToSupabase(companyId, tokens, userId = null) {
    try {
        const response = await axios.post(`${SUPABASE_URL}/quickbooks/tokens`, {
            company_id: companyId,
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
            realm_id: tokens.realmId,
            expires_at: new Date(tokens.expires_at).toISOString(),
            user_id: userId
        });
        
        console.log('✅ Tokens saved to Supabase');
        return response.data?.success || true;
    } catch (error) {
        console.error('❌ Error saving tokens to Supabase:', error.response?.data || error.message);
        return false;
    }
}

// ✅ Update tokens in Supabase
async function updateTokensInSupabase(companyId, tokens, userId = null) {
    try {
        const response = await axios.put(`${SUPABASE_URL}/quickbooks/tokens/${companyId}`, {
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
            expires_at: new Date(tokens.expires_at).toISOString(),
            user_id: userId
        });
        
        console.log('✅ Tokens updated in Supabase');
        return response.data?.success || true;
    } catch (error) {
        console.error('❌ Error updating tokens in Supabase:', error.response?.data || error.message);
        return false;
    }
}

// ✅ Get valid token (with refresh)
async function getValidToken(companyId) {
    let tokens = await getTokensFromSupabase(companyId);
    
    if (!tokens || !tokens.access_token) {
        throw new Error('Not authenticated with QuickBooks. Please visit /api/quickbooks/auth');
    }

    const expiresAt = new Date(tokens.expires_at).getTime();
    const now = Date.now();

    // Check if token is expired
    if (now >= expiresAt) {
        console.log('🔄 Token expired, refreshing...');
        try {
            oauthClient.setToken({
                access_token: tokens.access_token,
                refresh_token: tokens.refresh_token,
                realmId: tokens.realm_id
            });
            
            const authResponse = await oauthClient.refresh();
            const newTokens = {
                access_token: authResponse.token.access_token,
                refresh_token: authResponse.token.refresh_token,
                realmId: tokens.realm_id,
                expires_at: Date.now() + (authResponse.token.expires_in * 1000)
            };
            
            await updateTokensInSupabase(companyId, newTokens);
            console.log('✅ Token refreshed successfully');
            return newTokens;
        } catch (error) {
            console.error('❌ Token refresh failed:', error);
            throw new Error('Token refresh failed. Please re-authenticate.');
        }
    }
    
    return {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        realmId: tokens.realm_id,
        expires_at: expiresAt
    };
}

const CheckAuth = (req, res) => {
    try {
        const { scopes } = OAuthClient;
        const { company_id, user_id } = req.query;

        // Add company_id and user_id to state for callback
        const authUrl = oauthClient.authorizeUri({
            scope: [
                scopes.Accounting,
                scopes.Email,
                scopes.OpenId,
                scopes.Profile,
            ],
            state: JSON.stringify({ company_id, user_id }) // Pass data through state
        });
        
        res.json({ authUrl: authUrl });
    } catch (error) {
        console.error('Error generating auth URL:', error);
        res.status(500).json({ error: 'Failed to generate auth URL' });
    }
}

// ✅ OAuth Callback - Save tokens to Supabase
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

        // Get company_id and user_id from state
        let companyId, userId;
        try {
            const state = JSON.parse(authResponse.token.state || '{}');
            companyId = state.company_id;
            userId = state.user_id;
        } catch (e) {
            console.error('Error parsing state:', e);
        }

        // Fallback to query params if state is not available
        if (!companyId) {
            companyId = req.query.company_id;
            userId = req.query.user_id;
        }

        if (!companyId) {
            throw new Error('company_id is required');
        }

        const saved = await saveTokensToSupabase(companyId, newTokens, userId);
        
        if (saved) {
            console.log('✅ OAuth callback successful, tokens saved to Supabase');
            // Send success message to parent window
            res.sendFile('quickbooks-success.html', { root: './public' });
        } else {
            throw new Error('Failed to save tokens');
        }
    } catch (error) {
        console.error('❌ Error in callback:', error);
        // Send error message to parent window
        res.redirect(`/quickbooks-error.html?error=${encodeURIComponent(error.message)}`);
    }
}

// ✅ Fetch Employees
const GetEmployeesQuickBooks = async (req, res) => {
    try {
        const companyId = req.query.company_id || req.body?.company_id;
        
        if (!companyId) {
            return res.status(400).json({ error: 'company_id is required' });
        }

        console.log('📂 Reading tokens from Supabase for company:', companyId);
        const validTokens = await getValidToken(companyId);
        
        console.log('✅ Valid tokens obtained');
        const url = `${oauthClient.environment === 'sandbox' 
            ? 'https://sandbox-quickbooks.api.intuit.com' 
            : 'https://quickbooks.api.intuit.com'}/v3/company/${validTokens.realmId}/query`;

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

const ImportEmployees = async (req, res) => {
    try {
        const { employees, companyId } = req.body;

        if (!employees || !Array.isArray(employees)) {
            return res.status(400).json({ error: 'Invalid employees data' });
        }

        console.log("SUPABASE_URL=", SUPABASE_URL);

        axios.post(`${SUPABASE_URL}/employeeList/quickbooks`, {
            data: employees,
            company_id: companyId,
        });

        res.json({
            success: true,
            imported: employees.length,
            message: "Employees in Process of Importing"
        });

    } catch (error) {
        console.error('Error importing employees:', error);
        res.status(500).json({ error: 'Failed to import employees' });
    }
}

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

        if (!quickbooksId || !clockInTime || !clockOutTime || !companyId) {
            return res.status(400).json({
                error: 'Missing required fields'
            });
        }

        const validTokens = await getValidToken(companyId);
        const baseUrl = oauthClient.environment === 'sandbox'
            ? 'https://sandbox-quickbooks.api.intuit.com'
            : 'https://quickbooks.api.intuit.com';

        const formattedDate = date || formatDateForQuickBooks(clockInTime);
        const formattedStartTime = formatTimeForQuickBooks(clockInTime);
        const formattedEndTime = formatTimeForQuickBooks(clockOutTime);
        const hours = totalHours || calculateHours(clockInTime, clockOutTime);

        const timeActivityData = {
            NameOf: "Employee",
            EmployeeRef: { value: quickbooksId },
            TxnDate: formattedDate,
            StartTime: formattedStartTime,
            EndTime: formattedEndTime,
            Hours: hours,
            Description: `Clock In: ${formatTime(clockInTime)} - Clock Out: ${formatTime(clockOutTime)}`
        };

        const response = await axios.post(
            `${baseUrl}/v3/company/${validTokens.realmId}/timeactivity`,
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

        res.json({
            success: true,
            message: 'Working hours updated in QuickBooks',
            data: response.data.TimeActivity
        });

    } catch (error) {
        console.error('Error updating working hours:', error.response?.data || error);
        res.status(500).json({
            error: 'Failed to update working hours',
            details: error.response?.data || error.message
        });
    }
}

const CheckConnectionStatus = async (req, res) => {
    try {
        const companyId = req.query.company_id;
        
        if (!companyId) {
            return res.status(400).json({ error: 'company_id is required' });
        }

        const response = await axios.get(`${SUPABASE_URL}/quickbooks/status/${companyId}`);
        res.json(response.data);
    } catch (error) {
        console.error('Error checking status:', error.message);
        res.json({ connected: false });
    }
}

const DisconnectQuickBooks = async (req, res) => {
    try {
        const { companyId, userId } = req.body;
        
        if (!companyId) {
            return res.status(400).json({ error: 'company_id is required' });
        }

        const tokens = await getTokensFromSupabase(companyId);
        
        if (tokens && tokens.access_token) {
            oauthClient.setToken({
                access_token: tokens.access_token,
                refresh_token: tokens.refresh_token,
                realmId: tokens.realm_id
            });
            
            try {
                await oauthClient.revoke();
            } catch (revokeError) {
                console.error('Error revoking token:', revokeError);
            }
        }

        await axios.delete(`${SUPABASE_URL}/quickbooks/tokens/${companyId}`, {
            data: { user_id: userId }
        });
        
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