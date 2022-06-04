
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
        const piece = '<p><span>' + text + '</span><img src="data:image/png;base64,' + buffer.toString('base64') + '" />' + "</p>\n"
        if (LOCAL_LOG) {
            stream.write(piece);
        }
        textLogContents += piece;
    }
    const logText = (text) => {
        const piece = '<p><span>' + text + "</span></p>\n"
        if (LOCAL_LOG) {
            stream.write(piece);
        }
        textLogContents += piece;
    }

    try {

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


        await page.goto('https://www.nabbroker.com.au/login#/auth');
        log('Initial load', await page.screenshot());

        await page.fill('input#username', config.credentials.username);
        await page.fill('input#password', config.credentials.password);
        await page.locator('button:has-text("Log in")').click();


        const wrongCredentialsLocator = page.locator('span:has-text("Your username or password is incorrect. Please try again.")');
        const repricingTollButtonLocator = page.locator('a#broker-app-link-id-instantPricing');

        try {
            await Promise.race([
                wrongCredentialsLocator.waitFor({timeout: 10000}),
                repricingTollButtonLocator.waitFor({timeout: 10000})
            ]);
        } catch (exception) {}
        log('Login attempted', await page.screenshot());


        if (await repricingTollButtonLocator.count() === 0) {
            throw new Error('Repricing tool button not found');
        }

        const [page1] = await Promise.all([
            context.waitForEvent('page'),
            repricingTollButtonLocator.click()
        ])
        await page1.waitForLoadState();

        log('Reprice tool in new tab', await page1.screenshot());

        ///////////////////////////

        await page1.locator('text=Yes').click();
        await page1.locator('text=Personal').click();

        await page1.locator('[data-testid="firstName"]').fill(config.customer.firstName);
        await page1.locator('[data-testid="lastName"]').fill(config.customer.lastName);
        await page1.locator('[data-testid="personalPhoneNumber"]').fill(config.customer.phone);
        await page1.locator('input[name="dob"]').fill(config.customer.dob);

        // Segment dropdown
        await page1.locator('#dropdown-toggle-button-customerSegment').click();
        await page1.locator('text=' + config.customer.segment).click();
        await page1.waitForTimeout(1000); // Let framework update internal state

        log('STEP', await page1.screenshot());

        // Next
        //await page1.locator('[data-testid="nextButton"]').click();
        await page1.locator('button:has-text("Next")').click();


        // Add loans (TODO in a cycle in future)

        //await page1.locator('[data-testid="addLoan"]').click();
        await page1.locator('button:has-text("Add a loan")').click();

        await page1.locator('text=Yes').click();
        await page1.locator('[data-testid="existingAccountNumber"]').fill(config.loans[0].loanNumber);
        await page1.locator('[data-testid="existingRate"]').fill(config.loans[0].interestRate.toString()); //TODO ensure X.Y format

        // Group & Product dropdowns
        await page1.locator('#dropdown-toggle-button-productGroup').click();
        await page1.locator('text=NON-PACKAGE Variable').click(); //TODO
        await page1.waitForTimeout(1000); // To have connected dropdown with products populated
        await page1.locator('#dropdown-toggle-button-product').click();
        await page1.locator('text=NON PACKAGED: Base Variable P+I').click(); //TODO

        await page1.locator('[data-testid="loanLimit"]').fill(config.loans[0].limit.toString());

        // Purpose dropdown
        await page1.locator('#dropdown-toggle-button-loanPurpose').click();
        await page1.locator('text=Residential Investor').click(); //TODO

        await page1.locator('[data-testid="postCode"]').fill(config.loans[0].postcode);

        // Dwelling type dropdown
        await page1.locator('#dropdown-toggle-button-dwellingType').click();
        await page1.locator('text=Non-Apartment').click(); //TODO

        await page1.locator('[data-testid="requestNewRate"] >> text=Yes').click();

        await page1.locator('[data-testid="hasCompetitorOffer"] >> text=Yes').click();

        // Competitor dropdown
        await page1.locator('#dropdown-toggle-button-competitorName').click();
        await page1.locator('text=CUA').click();

        // Competitor product dropdown
        await page1.locator('#dropdown-toggle-button-competitorProductType').click();
        await page1.locator('text=Package - Variable').click(); //TODO

        await page1.locator('[data-testid="competitorRate"]').fill(config.loans[0].competitor.rate.toString()); //TODO

        await page1.locator('[data-testid="requestedRate"]').fill(config.loans[0].requestedRate.toString());

        log('STEP', await page1.screenshot());

        // Next (add loan)
        //await page1.locator('[data-testid="nextButton"]').click();
        await page1.locator('button:has-text("Add loan")').click();

        // Note: we should be back to table with all added loands now

        // Request type dropdown
        await page1.waitForTimeout(1000);
        await page1.locator('#dropdown-toggle-button-requestType').click();
        await page1.locator('text=Existing lending only').click();
        await page1.waitForTimeout(1000);

        await page1.locator('[data-testid="totalSecurityValue"]').fill(config.totalValue.toString());

        log('STEP', await page1.screenshot());

        // Next - to confirmation screen
        //await page1.locator('[data-testid="nextButton"]').click();
        await page1.locator('button:has-text("Next")').click();

        log('STEP', await page1.screenshot());

        // Next - to decision screen
        //await page1.locator('[data-testid="nextButton"]').click();
        await page1.locator('button:has-text("Submit")').click();

        log('STEP', await page1.screenshot());


        // Extract offered rate
        const offeredRateLabelText = await page1.locator('td[headers="proposedRate"]').allTextContents();
        logText('Offer: ' + offeredRateLabelText.join(' '));


        // Escalate button
        //await page1.locator('[data-testid="backButton"]').click();
        await page1.locator('button:has-text("Escalate")').click();
        // Note: there also is "Accept" button

        // Escalation reason dropdown
        await page1.locator('#dropdown-toggle-button-escalationReasonCode').click();
        await page1.locator('text=Manual review required (Pricing Team use only)').click();

        await page1.locator('textarea#comments').fill(config.escalationMessage);

        log('STEP', await page1.screenshot());

        // Submit escalation TODO
        //await page1.locator('button:has-text("Submit")').click();
        

        await page.locator('button:has-text("Log out")').click();
        await page.waitForTimeout(3000);
        log('After logout', await page.screenshot());

        await context.close();
        await browser.close();
    }
    catch(exception) {
        logText(exception.toString());
    }

    // Finalize local log and upload log to s3
    textLogContents += '<footer></footer></body></html>'

    if (LOCAL_LOG) {
        stream.end();
    }

    const results = await s3Client.send(new PutObjectCommand({Bucket: 'reprice-logs', Key: bucket_log_file, Body: textLogContents}));
    
    return bucket_log_file;
}

exports.handler = handler;


const selectOptionByVisibleText = async (page, selector, text) => {
    const selectLocator = page.locator(selector);

    const optionLocator = selectLocator.locator('option:has-text("' + text + '")');

    const targetValue = await optionLocator.getAttribute('value');

    await page.selectOption(selector, targetValue);
}