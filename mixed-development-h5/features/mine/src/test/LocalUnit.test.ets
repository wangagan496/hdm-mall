import { describe, beforeAll, beforeEach, afterEach, afterAll, it, expect } from '@ohos/hypium';
import { HDMUser } from 'models';
import { mergeBridgeUser } from '../main/ets/presentation/views/userBridgePresentation';

export default function localUnitTest() {
  describe('localUnitTest', () => {
    // Defines a test suite. Two parameters are supported: test suite name and test suite function.
    beforeAll(() => {
      // Presets an action, which is performed only once before all test cases of the test suite start.
      // This API supports only one parameter: preset action function.
    });
    beforeEach(() => {
      // Presets an action, which is performed before each unit test case starts.
      // The number of execution times is the same as the number of test cases defined by **it**.
      // This API supports only one parameter: preset action function.
    });
    afterEach(() => {
      // Presets a clear action, which is performed after each unit test case ends.
      // The number of execution times is the same as the number of test cases defined by **it**.
      // This API supports only one parameter: clear action function.
    });
    afterAll(() => {
      // Presets a clear action, which is performed after all test cases of the test suite end.
      // This API supports only one parameter: clear action function.
    });
    it('assertContain', 0, () => {
      // Defines a test case. This API supports three parameters: test case name, filter parameter, and test case function.
      let a = 'abc';
      let b = 'b';
      // Defines a variety of assertion methods, which are used to declare expected boolean conditions.
      expect(a).assertContain(b);
      expect(a).assertEqual(a);
    });
    it('mergesProfileOnlyForCurrentSessionAndUser', 0, () => {
      const current: HDMUser = {
        id: 'current-user',
        identity: 'buyer',
        identities: ['buyer', 'merchant'],
        identityRevision: 3,
        token: 'session-token',
        nickname: '旧昵称',
        avatar: 'old-avatar.jpg',
        account: 'zhousg'
      };
      const profileUpdate: HDMUser = {
        id: 'current-user',
        identity: 'buyer',
        identityRevision: 3,
        token: 'session-token',
        nickname: '新昵称',
        avatar: 'new-avatar.jpg',
        account: 'untrusted-account'
      };

      const merged: HDMUser = mergeBridgeUser(current, profileUpdate);

      expect(merged.token).assertEqual('session-token');
      expect(merged.nickname).assertEqual('新昵称');
      expect(merged.avatar).assertEqual('new-avatar.jpg');
      expect(merged.account).assertEqual('zhousg');
      expect(merged.id).assertEqual('current-user');
      expect(merged.identity).assertEqual('buyer');
      expect(merged.identities?.length).assertEqual(2);
      expect(merged.identityRevision).assertEqual(3);
    });
    it('rejectsOtherIdentityAndStaleIdentityRevision', 0, () => {
      const current: HDMUser = {
        id: 'current-user', identity: 'buyer', identityRevision: 3,
        token: 'session-token', nickname: '旧昵称', avatar: '', account: 'zhousg'
      };
      const otherIdentity: HDMUser = {
        id: 'current-user', identity: 'merchant', identityRevision: 3,
        token: 'session-token', nickname: '新昵称', avatar: '', account: 'zhousg'
      };
      const staleRevision: HDMUser = {
        id: 'current-user', identity: 'buyer', identityRevision: 1,
        token: 'session-token', nickname: '新昵称', avatar: '', account: 'zhousg'
      };
      [otherIdentity, staleRevision].forEach((update: HDMUser) => {
        let rejected: boolean = false;
        try { mergeBridgeUser(current, update); } catch { rejected = true; }
        expect(rejected).assertTrue();
      });
    });
    it('rejectsMissingOrMismatchedSessionToken', 0, () => {
      const current: HDMUser = { id: 'current-user', token: 'session-token', nickname: '旧昵称', avatar: '', account: 'zhousg' };
      ['', 'other-token'].forEach((token: string) => {
        const update: HDMUser = { id: 'current-user', token, nickname: '新昵称', avatar: '', account: 'zhousg' };
        let rejected: boolean = false;
        try { mergeBridgeUser(current, update); } catch { rejected = true; }
        expect(rejected).assertTrue();
      });
    });
    it('rejectsMismatchedUserId', 0, () => {
      const current: HDMUser = { id: 'current-user', token: 'session-token', nickname: '旧昵称', avatar: '', account: 'zhousg' };
      const update: HDMUser = { id: 'other-user', token: 'session-token', nickname: '新昵称', avatar: '', account: 'zhousg' };
      let rejected: boolean = false;
      try { mergeBridgeUser(current, update); } catch { rejected = true; }
      expect(rejected).assertTrue();
    });
  });
}
