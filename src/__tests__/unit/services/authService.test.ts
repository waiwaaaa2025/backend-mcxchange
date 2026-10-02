/**
 * Auth Service Unit Tests
 *
 * Models, Stripe, email and admin notifications are mocked; bcrypt and jwt
 * run for real (with cheap rounds) so hashing and token signing are covered.
 */

import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

jest.mock('../../../models', () => ({
  User: { findOne: jest.fn(), findByPk: jest.fn(), create: jest.fn() },
  RefreshToken: { create: jest.fn(), findOne: jest.fn(), destroy: jest.fn() },
  PasswordResetToken: { create: jest.fn(), findOne: jest.fn(), destroy: jest.fn() },
  EmailVerificationToken: { create: jest.fn(), findOne: jest.fn(), destroy: jest.fn() },
  UserTermsAcceptance: { create: jest.fn() },
  UserRole: { BUYER: 'BUYER', SELLER: 'SELLER', ADMIN: 'ADMIN', COMPLIANCE_MANAGER: 'COMPLIANCE_MANAGER' },
  UserStatus: { ACTIVE: 'ACTIVE', BLOCKED: 'BLOCKED', SUSPENDED: 'SUSPENDED', PENDING_VERIFICATION: 'PENDING_VERIFICATION' },
}));

jest.mock('../../../config', () => ({
  config: {
    jwt: {
      secret: 'test-secret',
      refreshSecret: 'test-refresh-secret',
      expiresIn: '15m',
      refreshExpiresIn: '7d',
    },
    security: { bcryptRounds: 4, passwordMinLength: 8 },
    frontendUrl: 'http://localhost:5173',
  },
}));

jest.mock('../../../services/stripeService', () => ({
  stripeService: { isEnabled: jest.fn().mockReturnValue(false), createCustomer: jest.fn() },
}));

jest.mock('../../../services/adminNotificationService', () => ({
  adminNotificationService: { notifyNewUser: jest.fn().mockResolvedValue(undefined) },
}));

jest.mock('../../../services/emailService', () => ({
  emailService: {
    sendWelcomeEmail: jest.fn().mockResolvedValue(true),
    sendVerificationEmail: jest.fn().mockResolvedValue(true),
    sendPasswordResetEmail: jest.fn().mockResolvedValue(true),
  },
}));

import { User, RefreshToken, PasswordResetToken, EmailVerificationToken, UserTermsAcceptance, UserRole, UserStatus } from '../../../models';
import { emailService } from '../../../services/emailService';
import { authService } from '../../../services/authService';

const mocked = (fn: unknown) => fn as jest.Mock;

const makeUser = (overrides: Record<string, unknown> = {}) => ({
  id: 'user-123',
  email: 'test@example.com',
  name: 'Test User',
  role: UserRole.BUYER,
  status: UserStatus.ACTIVE,
  password: bcrypt.hashSync('Password123!', 4),
  verified: false,
  emailVerified: false,
  trustScore: 50,
  memberSince: new Date('2026-01-01'),
  totalCredits: 0,
  usedCredits: 0,
  carrierPulseAccess: false,
  update: jest.fn().mockResolvedValue(undefined),
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
  mocked(RefreshToken.create).mockResolvedValue({});
});

describe('AuthService', () => {
  describe('register', () => {
    const input = {
      email: 'Test@Example.com',
      password: 'Password123!',
      name: 'Test User',
      role: UserRole.BUYER,
      termsAccepted: true,
      ipAddress: '1.2.3.4',
    };

    it('creates the user with a hashed password and returns tokens', async () => {
      mocked(User.findOne).mockResolvedValue(null);
      mocked(User.create).mockImplementation(async (data: any) => makeUser({ ...data }));

      const result = await authService.register(input);

      expect(User.findOne).toHaveBeenCalledWith({ where: { email: 'test@example.com' } });
      const created = mocked(User.create).mock.calls[0][0];
      expect(created.email).toBe('test@example.com');
      expect(created.password).not.toBe(input.password);
      expect(await bcrypt.compare(input.password, created.password)).toBe(true);

      expect(result.user).toMatchObject({ id: 'user-123', email: 'test@example.com', role: UserRole.BUYER });
      expect(result.user).not.toHaveProperty('password');
      expect((jwt.verify(result.tokens.accessToken, 'test-secret') as any).id).toBe('user-123');
      expect(RefreshToken.create).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-123', token: result.tokens.refreshToken })
      );
    });

    it('records the signup Terms acceptance', async () => {
      mocked(User.findOne).mockResolvedValue(null);
      mocked(User.create).mockImplementation(async (data: any) => makeUser({ ...data }));

      await authService.register(input);

      expect(UserTermsAcceptance.create).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-123', ipAddress: '1.2.3.4', termsVersion: 'register-checkbox-1.0' })
      );
    });

    it('rejects an email that is already registered', async () => {
      mocked(User.findOne).mockResolvedValue(makeUser());
      await expect(authService.register(input)).rejects.toThrow('User with this email already exists');
      expect(User.create).not.toHaveBeenCalled();
    });
  });

  describe('login', () => {
    it('logs in with the right password', async () => {
      const user = makeUser();
      mocked(User.findOne).mockResolvedValue(user);

      const result = await authService.login({ email: 'TEST@example.com', password: 'Password123!' });

      expect(User.findOne).toHaveBeenCalledWith({ where: { email: 'test@example.com' } });
      expect(result.user.email).toBe('test@example.com');
      expect(result.tokens.accessToken).toBeTruthy();
      expect(user.update).toHaveBeenCalledWith({ lastLoginAt: expect.any(Date) });
    });

    it('rejects an unknown email and a wrong password with the same message', async () => {
      mocked(User.findOne).mockResolvedValue(null);
      await expect(authService.login({ email: 'x@y.com', password: 'Password123!' })).rejects.toThrow(
        'Invalid email or password'
      );
      mocked(User.findOne).mockResolvedValue(makeUser());
      await expect(authService.login({ email: 'test@example.com', password: 'wrong-pass' })).rejects.toThrow(
        'Invalid email or password'
      );
    });

    it('rejects blocked and suspended accounts', async () => {
      mocked(User.findOne).mockResolvedValue(makeUser({ status: UserStatus.BLOCKED }));
      await expect(authService.login({ email: 'test@example.com', password: 'Password123!' })).rejects.toThrow(
        'blocked'
      );
      mocked(User.findOne).mockResolvedValue(makeUser({ status: UserStatus.SUSPENDED }));
      await expect(authService.login({ email: 'test@example.com', password: 'Password123!' })).rejects.toThrow(
        'suspended'
      );
    });

    it('runs the session as compliance manager when the user has Carrier Pulse access', async () => {
      mocked(User.findOne).mockResolvedValue(makeUser({ carrierPulseAccess: true }));
      const result = await authService.login({
        email: 'test@example.com',
        password: 'Password123!',
        roleHint: 'compliance_manager',
      });
      expect(result.user.role).toBe(UserRole.COMPLIANCE_MANAGER);
      expect(result.needsSubscription).toBeUndefined();
      expect((jwt.decode(result.tokens.accessToken) as any).role).toBe(UserRole.COMPLIANCE_MANAGER);
    });

    it('flags needsSubscription when the hinted role is missing', async () => {
      mocked(User.findOne).mockResolvedValue(makeUser());
      const result = await authService.login({
        email: 'test@example.com',
        password: 'Password123!',
        roleHint: 'compliance_manager',
      });
      expect(result.user.role).toBe(UserRole.BUYER);
      expect(result.needsSubscription).toBe('compliance_manager');
    });
  });

  describe('refreshToken', () => {
    it('rotates a valid refresh token', async () => {
      const token = jwt.sign({ id: 'user-123' }, 'test-refresh-secret');
      const stored = {
        expiresAt: new Date(Date.now() + 86400000),
        user: makeUser(),
        destroy: jest.fn(),
      };
      mocked(RefreshToken.findOne).mockResolvedValue(stored);

      const tokens = await authService.refreshToken(token);

      expect(stored.destroy).toHaveBeenCalled();
      expect(tokens.accessToken).toBeTruthy();
      expect(RefreshToken.create).toHaveBeenCalled();
    });

    it('rejects unknown, expired and badly signed tokens', async () => {
      mocked(RefreshToken.findOne).mockResolvedValue(null);
      await expect(authService.refreshToken('nope')).rejects.toThrow('Invalid refresh token');

      const expired = { expiresAt: new Date(Date.now() - 1000), destroy: jest.fn() };
      mocked(RefreshToken.findOne).mockResolvedValue(expired);
      await expect(authService.refreshToken('x')).rejects.toThrow('Refresh token expired');
      expect(expired.destroy).toHaveBeenCalled();

      const forged = { expiresAt: new Date(Date.now() + 86400000), destroy: jest.fn(), user: makeUser() };
      mocked(RefreshToken.findOne).mockResolvedValue(forged);
      await expect(authService.refreshToken(jwt.sign({ id: 'u' }, 'wrong-secret'))).rejects.toThrow(
        'Invalid refresh token'
      );
      expect(forged.destroy).toHaveBeenCalled();
    });
  });

  describe('logout', () => {
    it('deletes the given refresh token', async () => {
      await authService.logout('refresh-token');
      expect(RefreshToken.destroy).toHaveBeenCalledWith({ where: { token: 'refresh-token' } });
    });

    it('logoutAll deletes every refresh token for the user', async () => {
      await authService.logoutAll('user-123');
      expect(RefreshToken.destroy).toHaveBeenCalledWith({ where: { userId: 'user-123' } });
    });
  });

  describe('password reset', () => {
    it('answers the same way for an unknown email (no enumeration)', async () => {
      mocked(User.findOne).mockResolvedValue(null);
      const result = await authService.requestPasswordReset('ghost@example.com');
      expect(result.message).toMatch(/If an account exists/);
      expect(emailService.sendPasswordResetEmail).not.toHaveBeenCalled();
    });

    it('emails a reset link for a real account', async () => {
      mocked(User.findOne).mockResolvedValue(makeUser());
      await authService.requestPasswordReset('test@example.com');
      expect(PasswordResetToken.destroy).toHaveBeenCalledWith({ where: { userId: 'user-123' } });
      expect(emailService.sendPasswordResetEmail).toHaveBeenCalledWith(
        'test@example.com',
        expect.objectContaining({ resetUrl: expect.stringContaining('/reset-password?token=') })
      );
    });

    it('resets the password and signs out everywhere', async () => {
      const user = makeUser();
      const resetToken = { userId: 'user-123', expiresAt: new Date(Date.now() + 3600000), update: jest.fn() };
      mocked(PasswordResetToken.findOne).mockResolvedValue(resetToken);
      mocked(User.findByPk).mockResolvedValue(user);

      await authService.resetPassword('tok', 'NewPassword1!');

      const newHash = user.update.mock.calls[0][0].password;
      expect(await bcrypt.compare('NewPassword1!', newHash)).toBe(true);
      expect(resetToken.update).toHaveBeenCalledWith({ usedAt: expect.any(Date) });
      expect(RefreshToken.destroy).toHaveBeenCalledWith({ where: { userId: 'user-123' } });
    });

    it('rejects an expired token and a too-short password', async () => {
      const expired = { userId: 'user-123', expiresAt: new Date(Date.now() - 1000), destroy: jest.fn() };
      mocked(PasswordResetToken.findOne).mockResolvedValue(expired);
      await expect(authService.resetPassword('tok', 'NewPassword1!')).rejects.toThrow(/expired/);

      mocked(PasswordResetToken.findOne).mockResolvedValue({
        userId: 'user-123',
        expiresAt: new Date(Date.now() + 3600000),
        update: jest.fn(),
      });
      mocked(User.findByPk).mockResolvedValue(makeUser());
      await expect(authService.resetPassword('tok', 'short')).rejects.toThrow(/at least 8/);
    });
  });

  describe('changePassword', () => {
    it('changes the password when the current one is right', async () => {
      const user = makeUser();
      mocked(User.findByPk).mockResolvedValue(user);
      await authService.changePassword('user-123', 'Password123!', 'NewPassword1!');
      expect(user.update).toHaveBeenCalledWith({ password: expect.any(String) });
      expect(RefreshToken.destroy).toHaveBeenCalledWith({ where: { userId: 'user-123' } });
    });

    it('rejects a wrong current password and reusing the same password', async () => {
      mocked(User.findByPk).mockResolvedValue(makeUser());
      await expect(authService.changePassword('user-123', 'wrong-pass', 'NewPassword1!')).rejects.toThrow(
        'Current password is incorrect'
      );
      await expect(authService.changePassword('user-123', 'Password123!', 'Password123!')).rejects.toThrow(
        'must be different'
      );
    });
  });

  describe('verifyEmail', () => {
    it('marks the email verified and the token used', async () => {
      const user = makeUser({ status: UserStatus.PENDING_VERIFICATION });
      const token = { userId: 'user-123', expiresAt: new Date(Date.now() + 3600000), update: jest.fn() };
      mocked(EmailVerificationToken.findOne).mockResolvedValue(token);
      mocked(User.findByPk).mockResolvedValue(user);

      await authService.verifyEmail('tok');

      expect(user.update).toHaveBeenCalledWith({ emailVerified: true, status: UserStatus.ACTIVE });
      expect(token.update).toHaveBeenCalledWith({ verifiedAt: expect.any(Date) });
    });

    it('rejects an unknown token', async () => {
      mocked(EmailVerificationToken.findOne).mockResolvedValue(null);
      await expect(authService.verifyEmail('nope')).rejects.toThrow('Invalid or expired verification token');
    });
  });

  describe('getUserById', () => {
    it('returns the public profile without the password', async () => {
      mocked(User.findByPk).mockResolvedValue(makeUser());
      const user = await authService.getUserById('user-123');
      expect(user).toMatchObject({ id: 'user-123', availableRoles: [UserRole.BUYER] });
      expect(user).not.toHaveProperty('password');
    });

    it('returns null for an unknown id', async () => {
      mocked(User.findByPk).mockResolvedValue(null);
      expect(await authService.getUserById('missing')).toBeNull();
    });
  });
});
