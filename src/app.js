
const fs = require('fs');

const config = require('./westpac.json');
const { firefox } = require('playwright');

const HEADLESS = true;
const RECORD_VIDEO = false;

// Handler
exports.handler = async function(lambda_event, lambda_context) {
    var stream = fs.createWriteStream("westpac.log.html");
    const log = (text, buffer) => stream.write('<br>' + text + '<br><img src="data:image/png;base64,' + buffer.toString('base64') + '" />' + "\n");
    const logText = (text) => stream.write('<br>' + text + "\n");

    const browser = await firefox.launch({headless: HEADLESS});
    const context = await browser.newContext(RECORD_VIDEO ? { recordVideo: { dir: 'videos/' } } : {});
    const page = await context.newPage();
    await page.goto('https://www.nabbroker.com.au/login#/auth');
    log('Initial load', await page.screenshot());


    await page.fill('input#username', config.credentials.username);
    await page.fill('input#password', config.credentials.password);
    await page.locator('button:has-text("Log in")').click();


    await page.waitForTimeout(5000);
    log('Login attempted', await page.screenshot());



    const [newPage] = await Promise.all([
        context.waitForEvent('page'),
        page.locator('a#broker-app-link-id-instantPricing').click()
    ])
    await newPage.waitForLoadState();
    //await newPage.waitForTimeout(5000);
    
    //Wait for input#brokerFirstName is filled
    const brokerName = await newPage.locator('input#brokerFirstName').inputValue();
    let tries = 0;
    while ((brokerName === '') && (tries < 10)) {
        await newPage.waitForTimeout(1000);
        tries++;
    }


    log('Reprice tool in new tab', await newPage.screenshot());

    await newPage.locator('button:has-text("Continue")').click();
    await newPage.locator('input#firstName').waitFor({timeout: 5000}); //TODO use same technique everywhere after clicking Next
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

    await browser.close();

    stream.end();
    

    return fs.readFileSync("westpac.log.html").toJSON();
}




const selectOptionByVisibleText = async (page, selector, text) => {
    const selectLocator = page.locator(selector);

    const optionLocator = selectLocator.locator('option:has-text("' + text + '")');

    const targetValue = await optionLocator.getAttribute('value');

    await page.selectOption(selector, targetValue);
}