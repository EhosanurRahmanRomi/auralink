const {test} = require('node:test');
const assert = require('node:assert/strict');
const {parseInvite,fingerprint,certificateDecisionForPin}=require('../src/core/invite.cjs');
const fp='ab'.repeat(32), key='a'.repeat(43);
test('invitation preserves exact origin and requires a certificate pin',()=>{
  assert.deepEqual(parseInvite(`https://192.168.1.20:45831/#key=${key}&fp=${fp}`),{url:'https://192.168.1.20:45831',roomKey:key,fingerprint:fp});
});
test('rejects insecure or malformed invitations',()=>{
  for(const input of [`http://localhost/#key=${key}&fp=${fp}`,`https://a:b@localhost/#key=${key}&fp=${fp}`,`https://localhost/evil#key=${key}&fp=${fp}`,`https://localhost/?token=x#key=${key}&fp=${fp}`,`https://localhost/#key=short&fp=${fp}`,`https://localhost/#key=${key}`,null]) assert.throws(()=>parseInvite(input));
});
test('a pinned invitation rejects replacement certificates even when a CA would trust them',async()=>{
  const selfsigned=require('selfsigned');
  const a=await selfsigned.generate(null,{keyType:'ec',algorithm:'sha256'});
  const b=await selfsigned.generate(null,{keyType:'ec',algorithm:'sha256'});
  assert.equal(certificateDecisionForPin(fingerprint(a.cert),a.cert,'net::ERR_CERT_AUTHORITY_INVALID'),0);
  assert.equal(certificateDecisionForPin(fingerprint(a.cert),b.cert,'net::OK'),-2);
  assert.equal(certificateDecisionForPin(fingerprint(a.cert),'malformed','net::OK'),-2);
  assert.equal(certificateDecisionForPin(null,b.cert,'net::OK'),-3);
  assert.equal(certificateDecisionForPin(null,b.cert,'net::ERR_CERT_AUTHORITY_INVALID'),-2);
});
