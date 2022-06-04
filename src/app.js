const fs = require('fs');
const { chromium } = require('playwright');
const { S3Client , PutObjectCommand } = require("@aws-sdk/client-s3");
const { randomUUID } = require('crypto');

const AWS_REGION = "ap-southeast-2";
const s3Client = new S3Client({ region: AWS_REGION });

const HEADLESS = false; // For local dev - MUST be false for Lambda environment
const LOCAL_LOG = true; // Write log to local file - MUST be false for Lambda environment

const engine = chromium;

const handler = async function(lambda_event, lambda_context) {
    console.log(lambda_event);

    const config = JSON.parse(lambda_event.body);

    if (LOCAL_LOG) {
        var stream = fs.createWriteStream("westpac.log.html");
    }

    const formattedDate = (new Date()).toISOString().replace(/[^0-9]/g, ''); // Note: msec, UTC
    const bucket_log_file = 'nab_' + formattedDate + '_' + randomUUID();

    var textLogContents = '<html><body><header></header>';
    const log = (text, buffer) => {
        const piece = '<p><h3>' + text + '</h3><img src="data:image/png;base64,' + buffer.toString('base64') + '" />' + "</p>\n"
        if (LOCAL_LOG) {
            stream.write(piece);
        }
        textLogContents += piece;
    }
    const logText = (text) => {
        const piece = '<p><h3>' + text + "</h3></p>\n"
        if (LOCAL_LOG) {
            stream.write(piece);
        }
        textLogContents += piece;
    }


    // NAB's broker portal uses Akamai that by default blocks "automated" (controlled) browsers from logging in.
    // For Chromium based browsers that is indicated by navigator.webdriver=true
    // Note: I used to check "browser validity" with https://bot.sannysoft.com

    // With Firefox there were no such issues, and the following script worked well.
    // However, it doesn't seem viable to launch Firefox inside AWS Lambda function due to lack (prohibition) of multi-cpu features.
    // As a result using Firefix is viable, but only in custom computing environment (EC2/Fargate).

    // Chrome, on the other side can be launched in a "single-process" mode - see args below.
    const args = [
        "--disable-blink-features=AutomationControlled", // To set navigator.webdriver=false (https://stackoverflow.com/questions/53039551/selenium-webdriver-modifying-navigator-webdriver-flag-to-prevent-selenium-detec/60403652#60403652)
        "--single-process", // Prevent multicore requirement - not available for AWS Lambda
        "--no-zygote", // Prevent multicore requirement - not available for AWS Lambda
        "--no-sandbox" // Required by --single-process
    ];
    const browser = await engine.launch({
        headless: HEADLESS, 
        args: args,
        ignoreDefaultArgs: ["--disable-extensions"], // Looks like availability of extensions API is being checked by Akamai

        // Potentially it is possible to use full Chrome, or any other browser based on Chrominum/Chrome.
        // I had success with launching Brave (thinking it will help avoiding some fingerprinting/detection).
        // You'll need to download compiled build from https://github.com/brave/brave-browser/releases
        // and use parameters below:
        //executablePath: '/opt/reprice-prototype/brave/brave',
        //channel: 'chrome-canary',
    });
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/101.0.4951.15 Safari/537.36',
        permissions: ['notifications'], // Looks like availability of extensions API is being checked by Akamai
    });

    
    const page = await context.newPage();

    // In headless mode only Chromium does not populate navigator.plugins and window.chrome variables.
    // Those variables are not writable, but we can mock them with getter.
    await page.addInitScript(() => {

        Object.defineProperty(navigator, 'plugins', {
            get: function() {
                return [{ name: "Chrome PDF Plugin", filename: "internal-pdf-viewer", description: "Portable Document Format" }];
            },
        });

        Object.defineProperty(window, 'chrome', {
            get: function() {
                return {runtime: {}};
            },
        });
    });


    // When taking a screenshot, if page is not "active", screenshot function timeouts :(
    // To be able to track which page we are currently working with, and to save
    // a screenshot in case of exception, save link to "current page".
    let currentPage = page;

    try {
        await page.goto('https://www.nabbroker.com.au/login#/auth');
        
        await page.fill('input#username', config.credentials.username);
        await page.fill('input#password', config.credentials.password);
        
        log('Before login submission', await page.screenshot());
        await page.locator('button:has-text("Log in")').click();

        const wrongCredentialsLocator = page.locator('span:has-text("Your username or password is incorrect. Please try again.")');
        const repricingTollButtonLocator = page.locator('a#broker-app-link-id-instantPricing');

        try {
            await Promise.race([
                wrongCredentialsLocator.waitFor({timeout: 15000}),
                repricingTollButtonLocator.waitFor({timeout: 15000})
            ]);
        } catch (exception) {
            throw new Error('Login race failed unexpectedly');
        }
        
        if (await repricingTollButtonLocator.count() === 0) {
            throw new Error('Repricing tool button not found');
        }

        log('Login complete', await page.screenshot());

        // Repricing tool opens in a new tab - we'll have a new page to operate with.
        // Note: Existing page won't be used until logout.
        const [page1] = await Promise.all([
            context.waitForEvent('page'),
            repricingTollButtonLocator.click()
        ]);

        currentPage = page1; // From now we are working with the newly opened page

        // Check that we got expected page
        await page1.waitForLoadState();
        await validateLayout(page1, 'input#brokerEmail');
        log('Reprice tool opened', await page1.screenshot());

        ////////////////////////////////////
        // First page - customer details

        await page1.locator('text=Yes').click();
        await page1.locator('text=Personal').click();
        await page1.locator('[data-testid="firstName"]').fill(config.customer.firstName);
        await page1.locator('[data-testid="lastName"]').fill(config.customer.lastName);
        await page1.locator('[data-testid="personalPhoneNumber"]').fill(config.customer.phone);
        await page1.locator('input[name="dob"]').fill(config.customer.dob);
        await selectFromDropdown(page1, '#dropdown-toggle-button-customerSegment', config.customer.segment);

        log('Customer details - before submitting', await page1.screenshot({ fullPage: true }));
        await page1.locator('button:has-text("Next")').click();


        ////////////////////////////////////
        // Loans list page

        const addLoanButtonSelectorText = 'button:has-text("Add a loan"), button:has-text("Add another loan")';

        // Check that we got expected page
        await validateLayout(page1, addLoanButtonSelectorText);
        log('Customer details - after submitting', await page1.screenshot({ fullPage: true }));

        for (let i = 0; i < config.loans.length; i++) {
            let loan = config.loans[i];

            // Check that we got expected page
            await validateLayout(page1, addLoanButtonSelectorText);

            await page1.locator(addLoanButtonSelectorText).click();

            await page1.locator('text=Yes').click();
            await page1.locator('#existingAccountNumber').fill(loan.loanNumber);
            await page1.locator('#existingRate').fill(formatInterestRate(loan.interestRate));

            // Group & Product dropdowns
            await selectFromDropdown(page1, '#dropdown-toggle-button-productGroup', loan.product.group);
            await selectFromDropdown(page1, '#dropdown-toggle-button-product', loan.product.product);

            await page1.locator('#loanLimit').fill(loan.limit.toString());

            await selectFromDropdown(page1, '#dropdown-toggle-button-loanPurpose', loan.purpose);

            await page1.locator('#postCode').fill(loan.postcode);

            await selectFromDropdown(page1, '#dropdown-toggle-button-dwellingType', loan.dwellingType);

            // Competition data
            await page1.locator('[data-testid="requestNewRate"] >> text=Yes').click();
            await page1.locator('[data-testid="hasCompetitorOffer"] >> text=Yes').click();
            await selectFromDropdown(page1, '#dropdown-toggle-button-competitorName', loan.competitor.name);
            await selectFromDropdown(page1, '#dropdown-toggle-button-competitorProductType', loan.competitor.product);
            await page1.locator('#competitorRate').fill(formatInterestRate(loan.competitor.rate));

            await page1.locator('#requestedRate').fill(formatInterestRate(loan.requestedRate));

            log('Loan details - before submitting', await page1.screenshot({ fullPage: true }));
            await page1.locator('button:has-text("Add loan")').click();
            // Note: we should be back to table with all added loands now
        };


        // Check that we got expected page
        await validateLayout(page1, addLoanButtonSelectorText);
        
        await selectFromDropdown(page1, '#dropdown-toggle-button-requestType', 'Existing lending only'); // Note: hardcoded value
        await page1.locator('input#totalSecurityValue').fill(config.totalValue.toString());

        log('All loans filled - before submission', await page1.screenshot({ fullPage: true }));
        await page1.locator('button:has-text("Next")').click();


        // Check that we got expected page
        await validateLayout(page1, 'button:has-text("Submit")');
        log('Confirmation page - before submission', await page1.screenshot({ fullPage: true }));
        await page1.locator('button:has-text("Submit")').click();



        // Check that we got expected page
        await validateLayout(page1, 'button:has-text("Accept")');

        
        // Extract offered rate
        const offeredRateLabelTexts = await page1.locator('[headers=proposedRate]').allTextContents();
        const offers = offeredRateLabelTexts.map(text => text.replace('Proposed rate', ''))
        // Note: in browser this works fine: document.querySelector('ipt-broker-miniapp').shadowRoot.querySelector('[headers=proposedRate] :not(span)').innerHTML
        logText('Offers: ' + offers.join(' '));
        

        log('Offer page - before making decision', await page1.screenshot({ fullPage: true }));
        await page1.locator('button:has-text("Escalate")').click();

        // Escalation reason dropdown
        await selectFromDropdown(page1, '#dropdown-toggle-button-escalationReasonCode', 'Manual review required (Pricing Team use only)'); // Note: hardcoded text
        await page1.locator('textarea#comments').fill(config.escalationMessage);

        log('Escalation - before submitting', await page1.screenshot({ fullPage: true }));
        //await page1.locator('button:has-text("Submit")').click(); //TODO
        
        page1.waitForTimeout(3000); //TODO
        log('Escalation - after submitting', await page1.screenshot({ fullPage: true }));

        // Logout (button is located on the first page only)
        await page.bringToFront();
        await page.locator('button:has-text("Log out")').click();
        await page.waitForTimeout(3000);
        log('After logout', await page.screenshot());

    } catch(exception) {
        // Global log for any exception - manually thrown or playwright's (timeout, etc)
        log('Exception: ' + exception.toString(), await currentPage.screenshot({ fullPage: true }));
    }

    // Try to gracefully shutdown browser regardless of any prior errors
    try {
        await context.close();
        await browser.close();
    } catch(exception) {}

    // Finalize local log and upload log to s3
    textLogContents += '<footer></footer></body></html>'

    if (LOCAL_LOG) {
        stream.end();
    }

    const results = await s3Client.send(new PutObjectCommand({Bucket: 'reprice-logs', Key: bucket_log_file, Body: textLogContents}));
    
    //TODO meaningful return - login failed / error / etc
    return bucket_log_file;
}

exports.handler = handler;


// Generic helper for <select> dropdown
const selectOptionByVisibleText = async (page, selector, text) => {
    const selectLocator = page.locator(selector);

    const optionLocator = selectLocator.locator('option:has-text("' + text + '")');

    const targetValue = await optionLocator.getAttribute('value');

    await page.selectOption(selector, targetValue);
}

const validateLayout = async (page, selector) => {
    try {
        await page.waitForSelector(selector, { timeout: 15000});
    } catch (exception) {
        // Instead of passing useless "timeout exception", make a more informative one
        throw new Error('Layout validation failed: ' + selector);
    }
}

// NAB's dropdowns don't use <selec> and <options>
const selectFromDropdown = async (page, selector, text) => {
    await page.locator(selector).click();
    await page.locator('text=' + text).click();
    await page.waitForTimeout(1000); // Let framework update internal state
}

const formatInterestRate = (interestRate) => {
    return new Intl.NumberFormat('en', {minimumFractionDigits: 1}).format(interestRate)
}