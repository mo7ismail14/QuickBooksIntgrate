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

    console.log("expiresAt: ",expiresAt);
    console.log("now: ",now);
    

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

        await axios.post(`${SUPABASE_URL}/employeeList/quickbooks`, {
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

        console.log("employeeId : ",employeeId);
        console.log("quickbooksId : ",quickbooksId);
        console.log("clockInTime : ",clockInTime);
        console.log("clockOutTime : ",clockOutTime);
        console.log("totalHours : ",totalHours);
        console.log("companyId : ",companyId);
        

        // Validate required fields
        if (!quickbooksId || !clockInTime || !clockOutTime) {
            return res.status(400).json({
                error: 'Missing required fields: quickbooksId, clockInTime, clockOutTime'
            });
        }

        const validTokens = await getValidToken(companyId);
        const realmId = validTokens.realmId;

        const baseUrl = oauthClient.environment === 'sandbox'
            ? 'https://sandbox-quickbooks.api.intuit.com'
            : 'https://quickbooks.api.intuit.com';

        // Format times correctly for QuickBooks
        const formattedDate = date || formatDateForQuickBooks(clockInTime);
        const formattedStartTime = clockInTime||formatTimeForQuickBooks(clockInTime);
        const formattedEndTime = clockOutTime||formatTimeForQuickBooks(clockOutTime);
        const hours = totalHours || calculateHours(clockInTime, clockOutTime);

        // Create TimeActivity in QuickBooks
        const timeActivityData = {
            NameOf: "Employee",
            EmployeeRef: {
                value: quickbooksId
            },
            TxnDate: formattedDate,
            StartTime: formattedStartTime,
            EndTime: formattedEndTime,
            // Hours: hours,
            Description: `Clock In: ${clockInTime} - Clock Out: ${clockOutTime} | Employee ID: ${employeeId}`
        };

        console.log('Sending to totalHours:', totalHours);
        console.log('Sending to QuickBooks:', timeActivityData);

        // Post TimeActivity to QuickBooks
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

// ✅ Get Time Activities for Specific Employee (CORRECTED)
const GetEmployeeTimeActivities = async (req, res) => {
    try {
        const { companyId, quickbooksId, startDate, endDate } = req.query;

        // Validate required fields
        if (!companyId || !quickbooksId) {
            return res.status(400).json({ 
                error: 'company_id and quickbooksId are required' 
            });
        }

        if (!startDate || !endDate) {
            return res.status(400).json({ 
                error: 'startDate and endDate are required',
                format: 'YYYY-MM-DD'
            });
        }

        console.log('📂 Reading tokens from Supabase for company:', companyId);
        const validTokens = await getValidToken(companyId);
        
        console.log('✅ Valid tokens obtained');
        const baseUrl = oauthClient.environment === 'sandbox'
            ? 'https://sandbox-quickbooks.api.intuit.com'
            : 'https://quickbooks.api.intuit.com';

        // ✅ CORRECTED QUERY - Get all TimeActivities in date range first
        const query = `SELECT * FROM TimeActivity WHERE TxnDate >= '${startDate}' AND TxnDate <= '${endDate}' ORDERBY TxnDate DESC`;

        console.log('📡 Fetching employee time activities from QuickBooks...');
        console.log('Query:', query);

        const response = await axios.get(
            `${baseUrl}/v3/company/${validTokens.realmId}/query`,
            {
                params: { query, minorversion: 65 },
                headers: {
                    'Authorization': `Bearer ${validTokens.access_token}`,
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                }
            }
        );

        const allTimeActivities = response.data.QueryResponse.TimeActivity || [];
        console.log(`✅ Found ${allTimeActivities.length} total time activities`);
        
        // ✅ Filter by employee on the client side
        const timeActivities = allTimeActivities.filter(activity => {
            return activity.EmployeeRef?.value === quickbooksId;
        });

        console.log("✅ TimeActivities: ",timeActivities);
        console.log(`✅ Filtered to ${timeActivities.length} activities for employee ${quickbooksId}`);
        
        // Calculate total hours
        const totalHours = timeActivities.reduce((sum, activity) => {
            console.log("activity.Hours: ",activity.Hours);
            
            return sum + (parseFloat(activity.Hours) || 0);
        }, 0);

        // Calculate total Minutes
        const totalMinutes = timeActivities.reduce((sum, activity) => {
            console.log("activity.Hours: ",activity.Minutes);
            
            return sum + (parseFloat(activity.Minutes) || 0);
        }, 0);

        // Map activities
        const mappedActivities = timeActivities.map((activity) => ({
            id: activity.Id,
            date: activity.TxnDate,
            start_time: activity.StartTime,
            end_time: activity.EndTime,
            hours: activity.Hours,
            minutes: activity.Minutes,
            description: activity.Description || null,
            billable_status: activity.BillableStatus || null,
            created_at: activity.MetaData?.CreateTime,
            updated_at: activity.MetaData?.LastUpdatedTime
        }));

        res.json({
            success: true,
            employee: {
                quickbooks_id: quickbooksId,
                name: timeActivities[0]?.EmployeeRef?.name || null
            },
            data: mappedActivities,
            summary: {
                total_activities: mappedActivities.length,
                total_hours: totalHours.toFixed(2),
                minutes: totalMinutes,
                date_range: {
                    start: startDate,
                    end: endDate
                }
            }
        });

    } catch (error) {
        console.error('❌ Error fetching employee time activities:', error.response?.data || error.message);
        res.status(500).json({
            error: 'Failed to fetch employee time activities from QuickBooks',
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


// Create an employee in QuickBooks
const CreateEmployee = async (req, res) => {
    try {
        const { companyId, employeeData } = req.body;

        // Validate required fields
        if (!companyId) {
            return res.status(400).json({ error: 'company_id is required' });
        }

        if (!employeeData?.first_name || !employeeData?.last_name) {
            return res.status(400).json({
                error: 'first_name and last_name are required'
            });
        }

        console.log('📋 Creating Employee:', { companyId, employeeData });

        const validTokens = await getValidToken(companyId);
        const baseUrl = oauthClient.environment === 'sandbox'
            ? 'https://sandbox-quickbooks.api.intuit.com'
            : 'https://quickbooks.api.intuit.com';

        // Prepare employee data for QuickBooks
        const newEmployee = {
            GivenName: employeeData.first_name,
            FamilyName: employeeData.last_name
        };

        // Add optional fields if provided
        if (employeeData.email) {
            newEmployee.PrimaryEmailAddr = {
                Address: employeeData.email
            };
        }

        if (employeeData.phone_number) {
            // Format phone number with country code if available
            const phoneNumber = employeeData.phone_code
                ? `${employeeData.phone_code}${employeeData.phone_number}`
                : employeeData.phone_number;

            newEmployee.PrimaryPhone = {
                FreeFormNumber: phoneNumber
            };
        }

        if (employeeData.display_name) {
            newEmployee.DisplayName = employeeData.display_name;
        }

        if (employeeData.employee_number) {
            newEmployee.EmployeeNumber = employeeData.employee_number;
        }

        console.log('📤 Sending employee data to QuickBooks:', JSON.stringify(newEmployee, null, 2));

        // Create employee in QuickBooks
        const response = await axios.post(
            `${baseUrl}/v3/company/${validTokens.realmId}/employee`,
            newEmployee,
            {
                headers: {
                    'Authorization': `Bearer ${validTokens.access_token}`,
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                },
                params: { minorversion: 65 }
            }
        );

        console.log('✅ Employee created successfully');

        res.json({
            success: true,
            message: 'Employee created in QuickBooks',
            data: {
                quickbooks_id: response.data.Employee.Id,
                first_name: response.data.Employee.GivenName,
                last_name: response.data.Employee.FamilyName,
                email: response.data.Employee.PrimaryEmailAddr?.Address || null,
                phone_number: response.data.Employee.PrimaryPhone?.FreeFormNumber || null,
                display_name: response.data.Employee.DisplayName || null,
                employee_number: response.data.Employee.EmployeeNumber || null,
                active: response.data.Employee.Active
            }
        });

    } catch (error) {
        console.error('❌ Error creating employee:', error.response?.data || error.message);
        res.status(500).json({
            error: 'Failed to create employee in QuickBooks',
            details: error.response?.data || error.message
        });
    }
};

// Edit an employee in QuickBooks
const EditEmployee = async (req, res) => {
    try {
        const {quickbooksId} = req.params;
        const { companyId, employeeData } = req.body;

        // Validate required fields
        if (!companyId || !quickbooksId) {
            return res.status(400).json({
                error: 'company_id and quickbooksId are required'
            });
        }

        console.log('📋 Editing Employee:', { companyId, quickbooksId, employeeData });

        const validTokens = await getValidToken(companyId);
        const baseUrl = oauthClient.environment === 'sandbox'
            ? 'https://sandbox-quickbooks.api.intuit.com'
            : 'https://quickbooks.api.intuit.com';

        // First, get the Employee to retrieve its full data and SyncToken
        const getResponse = await axios.get(
            `${baseUrl}/v3/company/${validTokens.realmId}/employee/${quickbooksId}`,
            {
                headers: {
                    'Authorization': `Bearer ${validTokens.access_token}`,
                    'Accept': 'application/json'
                },
                params: { minorversion: 65 }
            }
        );

        const existingEmployee = getResponse.data.Employee;
        console.log('✅ Retrieved existing employee, SyncToken:', existingEmployee.SyncToken);

        // Prepare updated employee data
        const updatedEmployee = {
            Id: quickbooksId,
            SyncToken: existingEmployee.SyncToken,
            sparse: true // Only update fields that are provided
        };

        // Update fields if provided
        if (employeeData.first_name) {
            updatedEmployee.GivenName = employeeData.first_name;
        }

        if (employeeData.last_name) {
            updatedEmployee.FamilyName = employeeData.last_name;
        }

        if (employeeData.email !== undefined) {
            updatedEmployee.PrimaryEmailAddr = {
                Address: employeeData.email
            };
        }

        if (employeeData.phone_number !== undefined) {
            const phoneNumber = employeeData.phone_code
                ? `${employeeData.phone_code}${employeeData.phone_number}`
                : employeeData.phone_number;

            updatedEmployee.PrimaryPhone = {
                FreeFormNumber: phoneNumber
            };
        }

        if (employeeData.display_name !== undefined) {
            updatedEmployee.DisplayName = employeeData.display_name;
        }

        if (employeeData.employee_number !== undefined) {
            updatedEmployee.EmployeeNumber = employeeData.employee_number;
        }

        if (employeeData.active !== undefined) {
            updatedEmployee.Active = employeeData.active;
        }

        console.log('📤 Sending updated employee data to QuickBooks:', JSON.stringify(updatedEmployee, null, 2));

        // Update employee in QuickBooks
        const response = await axios.post(
            `${baseUrl}/v3/company/${validTokens.realmId}/employee`,
            updatedEmployee,
            {
                headers: {
                    'Authorization': `Bearer ${validTokens.access_token}`,
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                },
                params: { minorversion: 65 }
            }
        );

        console.log('✅ Employee updated successfully');

        res.json({
            success: true,
            message: 'Employee updated in QuickBooks',
            data: {
                quickbooks_id: response.data.Employee.Id,
                first_name: response.data.Employee.GivenName,
                last_name: response.data.Employee.FamilyName,
                email: response.data.Employee.PrimaryEmailAddr?.Address || null,
                phone_number: response.data.Employee.PrimaryPhone?.FreeFormNumber || null,
                display_name: response.data.Employee.DisplayName || null,
                employee_number: response.data.Employee.EmployeeNumber || null,
                active: response.data.Employee.Active,
                sync_token: response.data.Employee.SyncToken
            }
        });

    } catch (error) {
        console.error('❌ Error editing employee:', error.response?.data || error.message);
        res.status(500).json({
            error: 'Failed to edit employee in QuickBooks',
            details: error.response?.data || error.message
        });
    }
};

// Add this to your QuickBooksServise.js
const DeleteEmployee = async (req, res) => {
    try {
        const quickbooksId = req.params.id
        const companyId = req.params.companyId

        if (!companyId || !quickbooksId) {
            return res.status(400).json({ 
                error: 'company_id and quickbooksId are required' 
            });
        }

        console.log('📋 Deleting Employee:', { companyId, quickbooksId });

        const validTokens = await getValidToken(companyId);
        const baseUrl = oauthClient.environment === 'sandbox'
            ? 'https://sandbox-quickbooks.api.intuit.com'
            : 'https://quickbooks.api.intuit.com';

        // First, get the Employee to retrieve its SyncToken
        const getResponse = await axios.get(
            `${baseUrl}/v3/company/${validTokens.realmId}/employee/${quickbooksId}`,
            {
                headers: {
                    'Authorization': `Bearer ${validTokens.access_token}`,
                    'Accept': 'application/json'
                },
                params: { minorversion: 65 }
            }
        );

        const employee = getResponse.data.Employee;
        const syncToken = employee.SyncToken;

        console.log('✅ Retrieved Employee, SyncToken:', syncToken);

        // Mark employee as inactive (QuickBooks doesn't allow hard delete)
        const inactivateResponse = await axios.post(
            `${baseUrl}/v3/company/${validTokens.realmId}/employee`,
            {
                Id: quickbooksId,
                SyncToken: syncToken,
                GivenName: employee.GivenName,
                FamilyName: employee.FamilyName,
                Active: false,
                sparse: true
            },
            {
                headers: {
                    'Authorization': `Bearer ${validTokens.access_token}`,
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                },
                params: { minorversion: 65 }
            }
        );

        console.log('✅ Employee marked as inactive successfully');

        res.json({
            success: true,
            message: 'Employee marked as inactive in QuickBooks',
            data: inactivateResponse.data.Employee
        });

    } catch (error) {
        console.error('❌ Error deleting employee:', error.response?.data || error.message);
        res.status(500).json({
            error: 'Failed to delete employee',
            details: error.response?.data || error.message
        });
    }
};



module.exports = {
    CheckAuth,
    OAuthCallbackHandler,
    GetEmployeesQuickBooks,
    ImportEmployees,
    CheckConnectionStatus,
    DisconnectQuickBooks,
    UpdateEmployeeWorkingHours,
    GetEmployeeTimeActivities,
    DeleteEmployee,
    CreateEmployee,
    EditEmployee
};