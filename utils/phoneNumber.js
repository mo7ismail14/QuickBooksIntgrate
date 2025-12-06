const { parsePhoneNumberFromString } = require('libphonenumber-js');

const GetPhoneNumber = (phoneNumber) => {
    // Validate input: ensure it's a non-empty string
    if (typeof phoneNumber !== 'string' || !phoneNumber.trim()) {
        console.error('Invalid phone number input:', phoneNumber);
        return null;
    }

    let countryCode = null;
    let nationalPhoneNumber = null;

    try {
        const parsedPhoneNumber = parsePhoneNumberFromString(phoneNumber);

        if (parsedPhoneNumber) {
            countryCode = parsedPhoneNumber.countryCallingCode;
            nationalPhoneNumber = parsedPhoneNumber.nationalNumber; // Extract the national phone number
        } else {
            console.warn('Unable to parse phone number:', phoneNumber);
        }
    } catch (err) {
        console.error('Error parsing phone number:', err.message);
    }

    return {
        countryCode,
        phoneNumber: nationalPhoneNumber
    };
}

// Helper function to extract country code from phone number
const  parsePhoneNumber = (fullNumber)=>{
    if (!fullNumber) {
        return { code: null, number: null };
    }

    const cleanNumber = fullNumber.toString().replace(/\D/g, ''); // Remove non-digits
    
    // Common country code patterns (1-3 digits)
    const countryCodePatterns = [
        { regex: /^(20)(\d{9,10})$/, codeLength: 2 },  // Egypt: 20 + 10 digits
        { regex: /^(971)(\d{9})$/, codeLength: 3 },  // UAE: 971 + 9 digits
        { regex: /^(966)(\d{9})$/, codeLength: 3 },  // Saudi: 966 + 9 digits
        { regex: /^(1)(\d{10})$/, codeLength: 1 },   // US/Canada: 1 + 10 digits
        { regex: /^(44)(\d{10})$/, codeLength: 2 },  // UK: 44 + 10 digits
        { regex: /^(\d{1,3})(\d{7,})$/, codeLength: 0 }, // Generic fallback
    ];

    for (const pattern of countryCodePatterns) {
        const match = cleanNumber.match(pattern.regex);
        if (match) {
            return {
                code: match[1],
                number: match[2]
            };
        }
    }

    // If no pattern matches, assume last 10 digits are the number
    if (cleanNumber.length > 10) {
        return {
            code: cleanNumber.slice(0, -10),
            number: cleanNumber.slice(-10)
        };
    }

    return { code: null, number: cleanNumber };
}

module.exports = {
    GetPhoneNumber,
    parsePhoneNumber
}
