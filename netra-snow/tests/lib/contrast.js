/* WCAG 2 contrast ratio of two #rrggbb colours: contrast('#f1f3f4', '#1b1b1f') -> 15.4 */
'use strict';
function lum(hex) {
    var v = [1, 3, 5].map(function (i) {
        var x = parseInt(hex.substr(i, 2), 16) / 255;
        return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
}
function contrast(a, b) {
    var la = lum(a), lb = lum(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
module.exports = { contrast: contrast, lum: lum };
