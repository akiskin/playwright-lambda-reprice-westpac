class BasicManipulationError extends Error {
    constructor(message) {
        super(message);
        this.name = this.constructor.name;
    }
}

class WrongCredentialsError extends BasicManipulationError {
    constructor() {
        super('Provided credentials are incorrect');
    }
}

module.exports = { WrongCredentialsError }