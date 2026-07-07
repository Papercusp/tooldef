"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.setResultAnnotator = setResultAnnotator;
exports.resetResultAnnotator = resetResultAnnotator;
exports.applyResultAnnotator = applyResultAnnotator;
let annotator = null;
/** Register the host result annotator (last registration wins). */
function setResultAnnotator(fn) {
    annotator = fn;
}
/** Clear the registered annotator — test seam + host teardown. */
function resetResultAnnotator() {
    annotator = null;
}
/**
 * Apply the registered annotator to a result. NO annotator ⇒ the result is returned
 * unchanged. A soft error result is passed through untouched (ambient lines never ride a
 * failed call). NEVER throws — a broken annotator must not fail the underlying tool call,
 * so a thrown annotator error is swallowed and the original result returned.
 */
function applyResultAnnotator(result, ctx) {
    if (!annotator || result.isError)
        return result;
    try {
        return annotator(result, ctx);
    }
    catch {
        return result;
    }
}
