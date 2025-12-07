const express = require('express');
const router = express.Router();


// service
const {
    CheckAuth,
    OAuthCallbackHandler,
    GetEmployeesQuickBooks,
    CheckConnectionStatus,
    DisconnectQuickBooks,
    UpdateEmployeeWorkingHours,
    ImportEmployees,
    GetEmployeeTimeActivities
} = require('../services/QuickBooksServise')


// 1. Initiate OAuth Flow
router.get('/auth', CheckAuth);

// 2. OAuth Callback Handler - MODIFIED TO CLOSE POPUP
router.get('/callback', OAuthCallbackHandler);


// 3. Fetch Employees from QuickBooks
router.get('/employees', GetEmployeesQuickBooks);

// 4. Import Employees to Your Database
router.post('/import', ImportEmployees);


// 5. Update Employee Working Hours (Clock Out)
router.post('/update-working-hours', UpdateEmployeeWorkingHours);

// 6. Update Employee Working Hours (Clock Out)
router.get('/employee-time-activities', GetEmployeeTimeActivities);


//  Check Connection Status
router.get('/status', CheckConnectionStatus);

// Disconnect QuickBooks
router.post('/disconnect', DisconnectQuickBooks);



module.exports = router;