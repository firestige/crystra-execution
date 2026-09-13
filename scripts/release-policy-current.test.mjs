import assert from 'node:assert/strict';
import test from 'node:test';
import {assertPrereleaseCandidate,assertFinalPromotionEligible} from './release-promotion-policy.ts';
test('Crystra tags bind the same component base version without accepting old tags',()=>{
 assert.doesNotThrow(()=>assertPrereleaseCandidate('crystra-execution-v0.1.0-rc.1','0.1.0'));
 assert.throws(()=>assertPrereleaseCandidate('0.1.0-rc.1','0.1.0'));
 const evidence={schemaVersion:'execution.release-qualification@1.0.0',packageVersion:'0.1.0',candidateTag:'crystra-execution-v0.1.0-rc.1',commit:'a'.repeat(40),artifactMetadataSha256:'sha256:'+'b'.repeat(64),componentGates:{status:'PASS'},remoteArtifactVerification:{status:'PASS'}};
 assert.doesNotThrow(()=>assertFinalPromotionEligible('crystra-execution-v0.1.0',evidence,evidence.commit));
 assert.throws(()=>assertFinalPromotionEligible('crystra-execution-v0.2.0',evidence,evidence.commit),/FINAL_VERSION_MISMATCH/);
});
