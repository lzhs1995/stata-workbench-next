"use strict";
// Fairness only: preserve chunk contents/order and the existing lifecycle.
const BEFORE = "}}if(I&&I._lineBuffer)";
const AFTER = "}/* codex patch rc.7.43: populated log chunks yield to host I/O */await this._delay(0);}if(I&&I._lineBuffer)";
function patchBundle(source,options={}) {
 const a=source.indexOf('async _tailLogLoop('),b=source.indexOf('async readLog(',a);
 if(a<0||b<a)throw Error('tail loop bounds missing');
 const body=source.slice(a,b);
 if(body.includes(AFTER))return options.finalize===false?source:require('./finalize_bundle_identity').finalize(source).text;
 if(body.split(BEFORE).length!==2)throw Error('tail-loop yield anchor missing or ambiguous');
 const result=source.slice(0,a)+body.replace(BEFORE,AFTER)+source.slice(b);
 return options.finalize===false?result:require('./finalize_bundle_identity').finalize(result).text;
}
module.exports={patchBundle};
