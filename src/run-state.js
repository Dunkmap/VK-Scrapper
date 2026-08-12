/**
 * Run-wide flags that route handlers need to raise to the entry point - for
 * example an error that should fail the whole run rather than just one request.
 */
export class RunState {
    constructor() {
        this.fatalError = null;
    }

    /**
     * Records the first fatal error; later ones are noise from in-flight requests.
     * @param {Error} error
     */
    recordFatal(error) {
        this.fatalError ??= error;
    }
}
