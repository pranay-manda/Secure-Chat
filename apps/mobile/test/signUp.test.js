/* global jest */
import { loadApp, mockApi, resetDevice, signIn, storedSession, USER } from './helpers';

/**
 * Sign-up/sign-in with email AND phone number (code to the email), phone sign-in kept as an
 * alternative, and the one-time screen that adds a missing email or phone to older accounts.
 */
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn() },
  useLocalSearchParams: () => globalThis.__routeParams ?? {},
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const flush = async () => {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

async function render(modulePath) {
  const React = require('react');
  const { act, create } = require('react-test-renderer');
  const Screen = require(modulePath);
  const Component = Screen.default ?? Screen.CompleteProfile;
  let tree;
  await act(async () => {
    tree = create(React.createElement(Component));
  });
  const byTestId = (id) => tree.root.findAll((n) => n.props.testID === id)[0];
  const type = async (id, text) => act(async () => byTestId(id).props.onChangeText(text));
  const press = async (title) => {
    const node = tree.root.findAll((n) => n.props.title === title && n.props.onPress)[0];
    await act(async () => node.props.onPress());
    await act(async () => flush());
  };
  const text = () =>
    tree.root
      .findAll((n) => typeof n.props.children === 'string')
      .map((n) => n.props.children)
      .join(' | ');
  return { tree, act, byTestId, type, press, text };
}

beforeEach(() => {
  jest.resetModules();
  resetDevice();
  globalThis.__routeParams = undefined;
});

describe('sign-in form', () => {
  const { readSignInForm } = require('../src/auth/signInForm');

  it('email sign-in needs both email and phone; the code is requested for the email only', () => {
    expect(readSignInForm({ mode: 'email', emailInput: '', phoneInput: '' }).error).toMatch(
      /email/,
    );
    expect(readSignInForm({ mode: 'email', emailInput: 'a@b.co', phoneInput: '' }).error).toMatch(
      /phone number/,
    );
    expect(
      readSignInForm({ mode: 'email', emailInput: 'a@b', phoneInput: '9876543210' }).error,
    ).toMatch(/valid email/);
    expect(
      readSignInForm({ mode: 'email', emailInput: 'a@b.co', phoneInput: '123' }).error,
    ).toMatch(/valid mobile/);
    expect(
      readSignInForm({
        mode: 'email',
        emailInput: ' Alice@Example.COM ',
        phoneInput: '98765 43210',
      }),
    ).toEqual({
      request: { email: 'alice@example.com' },
      verify: { email: 'alice@example.com', phoneNumber: '+919876543210' },
    });
  });

  it('phone sign-in (code by SMS) needs only the number', () => {
    expect(readSignInForm({ mode: 'phone', emailInput: '', phoneInput: '98765 43210' })).toEqual({
      request: { phoneNumber: '+919876543210' },
      verify: { phoneNumber: '+919876543210' },
    });
  });
});

describe('sign-in and verify screens', () => {
  it('requests the code for the email and carries the phone number to verification', async () => {
    const calls = mockApi({
      'POST /auth/otp/request': () => ({
        status: 202,
        body: { expiresInSeconds: 300, resendAfterSeconds: 60 },
      }),
    });
    const ui = await render('../src/app/sign-in');
    expect(ui.text()).toMatch(/CipherChat/);
    await ui.type('email-input', 'alice@example.com');
    await ui.press('Continue');
    expect(ui.text()).toMatch(/Enter your phone number/);
    expect(calls).toHaveLength(0);

    await ui.type('phone-input', '+91 98765 43210');
    await ui.press('Continue');
    expect(calls.map((c) => [c.key, c.body])).toEqual([
      ['POST /auth/otp/request', { email: 'alice@example.com' }],
    ]);
    expect(require('expo-router').router.push).toHaveBeenCalledWith({
      pathname: '/verify',
      params: { email: 'alice@example.com', phoneNumber: '+919876543210', resendAfterSeconds: 60 },
    });
  });

  it('keeps phone sign-in as an alternative', async () => {
    const calls = mockApi({
      'POST /auth/otp/request': () => ({ status: 202, body: { resendAfterSeconds: 60 } }),
    });
    const ui = await render('../src/app/sign-in');
    await ui.press('Sign in with phone number instead');
    expect(ui.byTestId('email-input')).toBeUndefined();
    await ui.type('phone-input', '9876543210');
    await ui.press('Continue');
    expect(calls[0].body).toEqual({ phoneNumber: '+919876543210' });
  });

  it('verifies the email code together with the phone number', async () => {
    globalThis.__routeParams = {
      email: 'alice@example.com',
      phoneNumber: '+919876543210',
      resendAfterSeconds: '60',
    };
    const calls = mockApi({
      'POST /auth/otp/verify': () => ({
        status: 409,
        body: { error: { code: 'PHONE_NUMBER_TAKEN' } },
      }),
    });
    const ui = await render('../src/app/verify');
    await ui.type('otp-input', '123456');
    await ui.act(async () => flush());
    expect(calls[0].body).toMatchObject({
      email: 'alice@example.com',
      phoneNumber: '+919876543210',
      otp: '123456',
    });
    expect(ui.text()).toMatch(/already used by another CipherChat account/);
  });
});

describe('adding a missing email or phone number', () => {
  async function signedInAs(user) {
    const app = loadApp();
    mockApi({
      'POST /auth/otp/verify': () => ({
        body: { user, device: {}, tokens: require('./helpers').makeTokens() },
      }),
    });
    await app.auth.useAuthStore.getState().verifyOtp({ email: user.email ?? 'x@y.z' }, '123456');
    return app;
  }

  it('a phone sign-in account adds its email with a code sent to it', async () => {
    const app = loadApp();
    await signIn(app); // USER: phone number, no email
    const calls = mockApi({
      'POST /account/email/otp': () => ({ status: 202, body: { resendAfterSeconds: 60 } }),
      'POST /account/email': ({ body }) => ({ body: { user: { ...USER, email: body.email } } }),
    });
    const ui = await render('../src/components/CompleteProfile');
    expect(ui.text()).toMatch(/Add your email/);
    await ui.type('profile-email-input', 'Alice@Example.com');
    await ui.press('Send code');
    await ui.type('profile-otp-input', '654321');
    await ui.press('Confirm');

    expect(calls.map((c) => [c.key, c.body])).toEqual([
      ['POST /account/email/otp', { email: 'alice@example.com' }],
      ['POST /account/email', { email: 'alice@example.com', otp: '654321' }],
    ]);
    expect(app.auth.useAuthStore.getState().user.email).toBe('alice@example.com');
    expect(storedSession().user.email).toBe('alice@example.com'); // kept after a restart too
  });

  it('an account without a number adds one (normalised); errors are shown', async () => {
    const user = { id: USER.id, email: 'alice@example.com', displayName: '' };
    const app = await signedInAs(user);
    let taken = true;
    const calls = mockApi({
      'POST /account/phone': ({ body }) =>
        taken
          ? { status: 409, body: { error: { code: 'PHONE_NUMBER_TAKEN' } } }
          : { body: { user: { ...user, phoneNumber: body.phoneNumber } } },
    });
    const ui = await render('../src/components/CompleteProfile');
    expect(ui.text()).toMatch(/Add your phone number/);
    await ui.type('profile-phone-input', '98765 43210');
    await ui.press('Save');
    expect(ui.text()).toMatch(/already used by another CipherChat account/);
    taken = false;
    await ui.press('Save');
    expect(calls.at(-1).body).toEqual({ phoneNumber: '+919876543210' });
    expect(app.auth.useAuthStore.getState().user.phoneNumber).toBe('+919876543210');
  });

  it('refreshUser updates a session cached before the account changed', async () => {
    const app = loadApp();
    await signIn(app);
    mockApi({
      'GET /account': () => ({ body: { user: { ...USER, email: 'alice@example.com' } } }),
    });
    await app.auth.useAuthStore.getState().refreshUser();
    expect(app.auth.useAuthStore.getState().user.email).toBe('alice@example.com');
    // Another account's details are never applied.
    mockApi({
      'GET /account': () => ({ body: { user: { ...USER, id: 'other', email: 'x@y.z' } } }),
    });
    await app.auth.useAuthStore.getState().refreshUser();
    expect(app.auth.useAuthStore.getState().user.email).toBe('alice@example.com');
  });
});
