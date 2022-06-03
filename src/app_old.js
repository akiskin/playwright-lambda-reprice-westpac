
const fs = require('fs');
const { chromium } = require('playwright');
const { S3Client , PutObjectCommand } = require("@aws-sdk/client-s3");

const AWS_REGION = "ap-southeast-2";
const s3Client = new S3Client({ region: AWS_REGION });

const HEADLESS = true; // For local dev - MUST be false for Lambda environment
const LOCAL_LOG = false; // Write log to local file - MUST be false for Lambda environment

const engine = chromium;

const handler = async function(lambda_event, lambda_context) {
    console.log(lambda_event);

    const config = JSON.parse(lambda_event.body);

    if (LOCAL_LOG) {
        var stream = fs.createWriteStream("westpac.log.html");
    }
    const bucket_log_file = 'example_file';

    var textLogContents = '';
    const log = (text, buffer) => {
        const piece = '<br>' + text + '<br><img src="data:image/png;base64,' + buffer.toString('base64') + '" />' + "\n"
        if (LOCAL_LOG) {
            stream.write(piece);
        }
        textLogContents += piece;
    }
    const logText = (text) => {
        const piece = '<br>' + text + "\n"
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

        const [newPage] = await Promise.all([
            context.waitForEvent('page'),
            repricingTollButtonLocator.click()
        ])
        await newPage.waitForLoadState();
        
        //Wait for input#brokerFirstName is filled
        let brokerName = await newPage.locator('input#brokerFirstName').inputValue();
        let tries = 0;
        while ((brokerName === '') && (tries < 10)) {
            await newPage.waitForTimeout(1000);
            brokerName = await newPage.locator('input#brokerFirstName').inputValue();
            tries++;
        }


        log('Reprice tool in new tab', await newPage.screenshot());

        await newPage.locator('button:has-text("Continue")').click();
        await newPage.locator('input#firstName').waitFor({timeout: 5000});
        log('After clicking Continue', await newPage.screenshot());


        ////
        // CUSTOMER INFO
        await newPage.fill('input#firstName', config.customer.firstName);
        await newPage.fill('input#lastName', config.customer.lastName);
        await newPage.fill('input#phoneNumber', config.customer.phone);
        await newPage.fill('input#dateOfBirth', config.customer.dob);
        await newPage.click('input#existingCustomeryes');
        log('Fill customer details', await newPage.screenshot());

        await newPage.locator('button:has-text("Continue")').click();
        await newPage.waitForTimeout(2000);
        log('After clicking Continue', await newPage.screenshot());


        ////
        // LOAN INFO
        await newPage.locator('input#yesExistingLoan0').waitFor({timeout: 3000});
        await newPage.locator('input#yesExistingLoan0').click();

        await newPage.fill('input#existingAccountNumber0', config.loans[0].loanNumber);
        await newPage.fill('input#existingRate0', config.loans[0].interestRate.toString());
        
        await selectOptionByVisibleText(newPage, 'select#productGroup0', config.loans[0].product.group);

        await selectOptionByVisibleText(newPage, 'select#product0', config.loans[0].product.product);
        await selectOptionByVisibleText(newPage, 'select#loanPurpose0', config.loans[0].purpose);

        await newPage.fill('input#loanLimit0', config.loans[0].limit.toString());
        await newPage.fill('input#securityPostcode0', config.loans[0].postcode);

        await selectOptionByVisibleText(newPage, 'select#dwellingType0', config.loans[0].dwellingType);


        await newPage.locator('input#yesReprice0').click(); //This makes visible the following fields:

        await newPage.fill('input#requestedRate0', config.loans[0].requestedRate.toString());
        
        await newPage.locator('input#yesCompetitorRate0').click();
        await newPage.locator('input#noWrittenConfirmation0').click();
        await selectOptionByVisibleText(newPage, 'select#competitorName0', config.loans[0].competitor.name);
        await selectOptionByVisibleText(newPage, 'select#competitorProduct0', config.loans[0].competitor.product);
        await newPage.fill('input#competitorRateOffered0', config.loans[0].competitor.rate.toString());
        
        log('Fill loan[0] details', await newPage.screenshot());
        await newPage.locator('button:has-text("Continue")').first().click();
        await newPage.waitForTimeout(2000);
        log('After clicking Continue', await newPage.screenshot());


        ////
        // ADDITIONAL INFO

        //TODO waitFor - check if modal is open
        await selectOptionByVisibleText(newPage, 'div.modal-content select#lblsegment:visible', config.customer.segment);
        await selectOptionByVisibleText(newPage, 'div.modal-content select#lblrequesttype:visible', 'Existing lending only');
        await newPage.fill('div.modal-content input#lbltotalSecurityValue:visible', config.totalValue.toString());

        log('Fill additional info', await newPage.screenshot());
        await newPage.locator('div.modal-body button:has-text("Submit"):visible').first().click();
        await newPage.waitForTimeout(2000);
        log('After clicking Submit', await newPage.screenshot());

        ////
        // CHECK OUTCOME AND ESCALATE

        const offeredRateLabelText = await newPage.locator('div.rateLabel').allTextContents();
        logText('Offer: ' + offeredRateLabelText.join(' '));

        await newPage.locator('button:has-text("Escalate")').first().click();

        
        await selectOptionByVisibleText(newPage, 'select#escalationReason', 'Manual review required (Pricing Team use only)');
        await newPage.fill('textarea#additionalInformation', config.escalationMessage);

        log('Fill escalation info', await newPage.screenshot());
        //TODO Submit escalation (button: Submit Escalation)

        

        await page.locator('button:has-text("Log out")').click();
        await page.waitForTimeout(3000);
        log('After logout', await page.screenshot());
    }
    catch(exception) {
        logText(exception.toString());
    }

    // Finalize local log and upload log to s3
    if (LOCAL_LOG) {
        stream.end();
    }

    const results = await s3Client.send(new PutObjectCommand({Bucket: 'reprice-logs', Key: bucket_log_file, Body: textLogContents}));
    
    try {
        await browser.close();
    } catch (exception) {}

    return bucket_log_file;
}

exports.handler = handler;


const selectOptionByVisibleText = async (page, selector, text) => {
    const selectLocator = page.locator(selector);

    const optionLocator = selectLocator.locator('option:has-text("' + text + '")');

    const targetValue = await optionLocator.getAttribute('value');

    await page.selectOption(selector, targetValue);
}