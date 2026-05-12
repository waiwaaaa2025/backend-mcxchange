import { DataTypes, Model, Optional } from 'sequelize';
import sequelize from '../config/database';

// ==================== ENUMS ====================

export enum UserRole {
  BUYER = 'BUYER',
  SELLER = 'SELLER',
  ADMIN = 'ADMIN'
}

export enum UserStatus {
  ACTIVE = 'ACTIVE',
  SUSPENDED = 'SUSPENDED',
  BLOCKED = 'BLOCKED',
  PENDING_VERIFICATION = 'PENDING_VERIFICATION'
}

export enum ListingStatus {
  DRAFT = 'DRAFT',
  PENDING_REVIEW = 'PENDING_REVIEW',
  ACTIVE = 'ACTIVE',
  SOLD = 'SOLD',
  RESERVED = 'RESERVED',
  SUSPENDED = 'SUSPENDED',
  REJECTED = 'REJECTED'
}

export enum ListingVisibility {
  PUBLIC = 'PUBLIC',
  PRIVATE = 'PRIVATE',
  UNLISTED = 'UNLISTED'
}

export enum SafetyRating {
  SATISFACTORY = 'SATISFACTORY',
  CONDITIONAL = 'CONDITIONAL',
  UNSATISFACTORY = 'UNSATISFACTORY',
  NONE = 'NONE'
}

export enum AmazonRelayStatus {
  NONE = 'NONE',
  PENDING = 'PENDING',
  ACTIVE = 'ACTIVE',
  SUSPENDED = 'SUSPENDED'
}

export enum AuthorityType {
  MOTOR_CARRIER = 'MOTOR_CARRIER',
  BROKER = 'BROKER',
  MOTOR_CARRIER_AND_BROKER = 'MOTOR_CARRIER_AND_BROKER',
  FREIGHT_FORWARDER = 'FREIGHT_FORWARDER'
}

export enum TruckCondition {
  EXCELLENT = 'EXCELLENT',
  GOOD = 'GOOD',
  FAIR = 'FAIR',
  POOR = 'POOR'
}

export enum DocumentType {
  INSURANCE = 'INSURANCE',
  UCC_FILING = 'UCC_FILING',
  AUTHORITY = 'AUTHORITY',
  SAFETY_RECORD = 'SAFETY_RECORD',
  BILL_OF_SALE = 'BILL_OF_SALE',
  ARTICLES_OF_INCORPORATION = 'ARTICLES_OF_INCORPORATION',
  EIN_LETTER = 'EIN_LETTER',
  LOSS_RUNS = 'LOSS_RUNS',
  LETTER_OF_RELEASE = 'LETTER_OF_RELEASE',
  PURCHASE_AGREEMENT = 'PURCHASE_AGREEMENT',
  SIGNED_AGREEMENT = 'SIGNED_AGREEMENT',
  OTHER = 'OTHER'
}

export enum DocumentStatus {
  PENDING = 'PENDING',
  VERIFIED = 'VERIFIED',
  REJECTED = 'REJECTED'
}

export enum OfferStatus {
  PENDING_ADMIN = 'PENDING_ADMIN',
  FORWARDED = 'FORWARDED',
  PENDING = 'PENDING',
  ACCEPTED = 'ACCEPTED',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  COUNTERED = 'COUNTERED',
  EXPIRED = 'EXPIRED',
  WITHDRAWN = 'WITHDRAWN'
}

export enum TransactionStatus {
  AWAITING_DEPOSIT = 'AWAITING_DEPOSIT',
  DEPOSIT_RECEIVED = 'DEPOSIT_RECEIVED',
  IN_REVIEW = 'IN_REVIEW',
  BUYER_APPROVED = 'BUYER_APPROVED',
  SELLER_APPROVED = 'SELLER_APPROVED',
  BOTH_APPROVED = 'BOTH_APPROVED',
  ADMIN_FINAL_REVIEW = 'ADMIN_FINAL_REVIEW',
  PAYMENT_PENDING = 'PAYMENT_PENDING',
  PAYMENT_RECEIVED = 'PAYMENT_RECEIVED',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
  DISPUTED = 'DISPUTED'
}

export enum PaymentStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  REFUNDED = 'REFUNDED'
}

export enum PaymentMethod {
  STRIPE = 'STRIPE',
  ZELLE = 'ZELLE',
  WIRE = 'WIRE',
  CHECK = 'CHECK'
}

export enum PaymentType {
  DEPOSIT = 'DEPOSIT',
  FINAL_PAYMENT = 'FINAL_PAYMENT',
  CREDIT_PURCHASE = 'CREDIT_PURCHASE',
  SUBSCRIPTION = 'SUBSCRIPTION',
  LISTING_FEE = 'LISTING_FEE',
  REFUND = 'REFUND'
}

export enum SubscriptionPlan {
  PACKAGE_TOOL = 'PACKAGE_TOOL',
  STARTER = 'STARTER',
  PROFESSIONAL = 'PROFESSIONAL',
  PREMIUM = 'PREMIUM',
  ENTERPRISE = 'ENTERPRISE',
  VIP_ACCESS = 'VIP_ACCESS'
}

export enum SubscriptionStatus {
  ACTIVE = 'ACTIVE',
  CANCELLED = 'CANCELLED',
  EXPIRED = 'EXPIRED',
  PAST_DUE = 'PAST_DUE'
}

export enum CreditTransactionType {
  PURCHASE = 'PURCHASE',
  USAGE = 'USAGE',
  REFUND = 'REFUND',
  BONUS = 'BONUS',
  EXPIRED = 'EXPIRED',
  SUBSCRIPTION = 'SUBSCRIPTION'
}

export enum NotificationType {
  OFFER = 'OFFER',
  MESSAGE = 'MESSAGE',
  VERIFICATION = 'VERIFICATION',
  REVIEW = 'REVIEW',
  TRANSACTION = 'TRANSACTION',
  SYSTEM = 'SYSTEM',
  PAYMENT = 'PAYMENT'
}

export enum PremiumRequestStatus {
  PENDING = 'PENDING',
  CONTACTED = 'CONTACTED',
  IN_PROGRESS = 'IN_PROGRESS',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED'
}

export enum ConsultationStatus {
  PENDING_PAYMENT = 'PENDING_PAYMENT',
  PAID = 'PAID',
  SCHEDULED = 'SCHEDULED',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
  REFUNDED = 'REFUNDED'
}

export enum AccountDisputeStatus {
  PENDING = 'PENDING',
  SUBMITTED = 'SUBMITTED',
  RESOLVED = 'RESOLVED',
  REJECTED = 'REJECTED'
}

// ==================== INTERFACES ====================

interface UserAttributes {
  id: string;
  email: string;
  password: string;
  name: string;
  phone?: string;
  avatar?: string;
  role: UserRole;
  status: UserStatus;
  verified: boolean;
  verifiedAt?: Date;
  trustScore: number;
  memberSince: Date;
  lastLoginAt?: Date;
  companyName?: string;
  companyAddress?: string;
  city?: string;
  state?: string;
  zipCode?: string;
  ein?: string;
  mcNumber?: string;
  dotNumber?: string;
  sellerVerified: boolean;
  sellerVerifiedAt?: Date;
  totalCredits: number;
  usedCredits: number;
  stripeCustomerId?: string;
  stripeAccountId?: string;
  emailVerified: boolean;
  identityVerified: boolean;
  identityVerifiedAt?: Date;
  stripeVerificationSessionId?: string;
  identityVerificationStatus?: string;
  carrierPulseAccess: boolean;
  carrierPulseStripeSubId?: string;
  promoAccessType?: string;
  promoAccessExpiresAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

interface UserCreationAttributes extends Optional<UserAttributes, 'id' | 'phone' | 'avatar' | 'status' | 'verified' | 'verifiedAt' | 'trustScore' | 'memberSince' | 'lastLoginAt' | 'companyName' | 'companyAddress' | 'city' | 'state' | 'zipCode' | 'ein' | 'mcNumber' | 'dotNumber' | 'sellerVerified' | 'sellerVerifiedAt' | 'totalCredits' | 'usedCredits' | 'stripeCustomerId' | 'stripeAccountId' | 'emailVerified' | 'identityVerified' | 'identityVerifiedAt' | 'stripeVerificationSessionId' | 'identityVerificationStatus' | 'carrierPulseAccess' | 'carrierPulseStripeSubId' | 'promoAccessType' | 'promoAccessExpiresAt' | 'createdAt' | 'updatedAt'> {}

// ==================== USER MODEL ====================

export class User extends Model<UserAttributes, UserCreationAttributes> implements UserAttributes {
  declare id: string;
  declare email: string;
  declare password: string;
  declare name: string;
  declare phone: string | undefined;
  declare avatar: string | undefined;
  declare role: UserRole;
  declare status: UserStatus;
  declare verified: boolean;
  declare verifiedAt: Date | undefined;
  declare trustScore: number;
  declare memberSince: Date;
  declare lastLoginAt: Date | undefined;
  declare companyName: string | undefined;
  declare companyAddress: string | undefined;
  declare city: string | undefined;
  declare state: string | undefined;
  declare zipCode: string | undefined;
  declare ein: string | undefined;
  declare mcNumber: string | undefined;
  declare dotNumber: string | undefined;
  declare sellerVerified: boolean;
  declare sellerVerifiedAt: Date | undefined;
  declare totalCredits: number;
  declare usedCredits: number;
  declare stripeCustomerId: string | undefined;
  declare stripeAccountId: string | undefined;
  declare emailVerified: boolean;
  declare identityVerified: boolean;
  declare identityVerifiedAt: Date | undefined;
  declare stripeVerificationSessionId: string | undefined;
  declare identityVerificationStatus: string | undefined;
  declare carrierPulseAccess: boolean;
  declare carrierPulseStripeSubId: string | undefined;
  declare promoAccessType: string | undefined;
  declare promoAccessExpiresAt: Date | undefined;
  declare readonly createdAt: Date;
  declare readonly updatedAt: Date;

  // Associations
  declare readonly listings?: Listing[];
  declare readonly sentOffers?: Offer[];
  declare readonly receivedOffers?: Offer[];
  declare readonly subscription?: Subscription;
}

User.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    email: {
      type: DataTypes.STRING(255),
      allowNull: false,
      unique: true,
    },
    password: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    name: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    phone: {
      type: DataTypes.STRING(50),
      allowNull: true,
    },
    avatar: {
      type: DataTypes.STRING(500),
      allowNull: true,
    },
    role: {
      type: DataTypes.ENUM(...Object.values(UserRole)),
      allowNull: false,
    },
    status: {
      type: DataTypes.ENUM(...Object.values(UserStatus)),
      defaultValue: UserStatus.ACTIVE,
    },
    verified: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    verifiedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    trustScore: {
      type: DataTypes.INTEGER,
      defaultValue: 50,
    },
    memberSince: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    },
    lastLoginAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    companyName: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    companyAddress: {
      type: DataTypes.STRING(500),
      allowNull: true,
    },
    city: {
      type: DataTypes.STRING(100),
      allowNull: true,
    },
    state: {
      type: DataTypes.STRING(50),
      allowNull: true,
    },
    zipCode: {
      type: DataTypes.STRING(20),
      allowNull: true,
    },
    ein: {
      type: DataTypes.STRING(50),
      allowNull: true,
    },
    mcNumber: {
      type: DataTypes.STRING(50),
      allowNull: true,
    },
    dotNumber: {
      type: DataTypes.STRING(50),
      allowNull: true,
    },
    sellerVerified: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    sellerVerifiedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    totalCredits: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    usedCredits: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    stripeCustomerId: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    stripeAccountId: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    emailVerified: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    identityVerified: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    identityVerifiedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    stripeVerificationSessionId: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    identityVerificationStatus: {
      type: DataTypes.STRING(50),
      allowNull: true,
    },
    carrierPulseAccess: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    carrierPulseStripeSubId: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    promoAccessType: {
      type: DataTypes.STRING(32),
      allowNull: true,
    },
    promoAccessExpiresAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  },
  {
    sequelize,
    tableName: 'users',
    indexes: [
      { fields: ['email'] },
      { fields: ['role'] },
      { fields: ['status'] },
      { fields: ['stripeCustomerId'] },
      { fields: ['stripeVerificationSessionId'] },
    ],
  }
);

// ==================== REFRESH TOKEN MODEL ====================

export class RefreshToken extends Model {
  declare id: string;
  declare token: string;
  declare userId: string;
  declare expiresAt: Date;
  declare readonly createdAt: Date;

  // Association
  declare user?: User;
}

RefreshToken.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    token: {
      type: DataTypes.STRING(500),
      allowNull: false,
      unique: true,
    },
    userId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    expiresAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
  },
  {
    sequelize,
    tableName: 'refresh_tokens',
    updatedAt: false,
    indexes: [
      { fields: ['userId'] },
      { fields: ['token'] },
    ],
  }
);

// ==================== PASSWORD RESET TOKEN MODEL ====================

export class PasswordResetToken extends Model {
  declare id: string;
  declare token: string;
  declare tokenHash: string;
  declare userId: string;
  declare expiresAt: Date;
  declare usedAt?: Date;
  declare readonly createdAt: Date;

  // Associations
  declare readonly user?: User;
}

PasswordResetToken.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    token: {
      type: DataTypes.STRING(100),
      allowNull: false,
      unique: true,
    },
    tokenHash: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    userId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    expiresAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    usedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  },
  {
    sequelize,
    tableName: 'password_reset_tokens',
    updatedAt: false,
    indexes: [
      { fields: ['userId'] },
      { fields: ['token'] },
      { fields: ['tokenHash'] },
    ],
  }
);

// ==================== EMAIL VERIFICATION TOKEN MODEL ====================

export class EmailVerificationToken extends Model {
  declare id: string;
  declare token: string;
  declare tokenHash: string;
  declare userId: string;
  declare email: string;
  declare expiresAt: Date;
  declare verifiedAt?: Date;
  declare readonly createdAt: Date;

  // Associations
  declare readonly user?: User;
}

EmailVerificationToken.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    token: {
      type: DataTypes.STRING(100),
      allowNull: false,
      unique: true,
    },
    tokenHash: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    userId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    email: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    expiresAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    verifiedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  },
  {
    sequelize,
    tableName: 'email_verification_tokens',
    updatedAt: false,
    indexes: [
      { fields: ['userId'] },
      { fields: ['token'] },
      { fields: ['tokenHash'] },
      { fields: ['email'] },
    ],
  }
);

// ==================== LISTING MODEL ====================

export class Listing extends Model {
  declare id: string;
  declare mcNumber: string;
  declare dotNumber: string;
  declare legalName: string;
  declare dbaName?: string;
  declare title: string;
  declare description?: string;
  declare askingPrice: number;
  declare listingPrice?: number;
  declare isPremium: boolean;
  declare isVip: boolean;
  declare freeToUnlock: boolean;
  declare status: ListingStatus;
  declare visibility: ListingVisibility;
  declare city: string;
  declare state: string;
  declare address?: string;
  declare yearsActive: number;
  declare fleetSize: number;
  declare totalDrivers: number;
  declare safetyRating: SafetyRating;
  declare saferScore?: string;
  declare insuranceOnFile: boolean;
  declare bipdCoverage?: number;
  declare cargoCoverage?: number;
  declare bondAmount?: number;
  declare amazonStatus: AmazonRelayStatus;
  declare amazonRelayScore?: string;
  declare authorityType: AuthorityType;
  declare highwaySetup: boolean;
  declare hasFactoring: boolean;
  declare factoringCompany?: string;
  declare factoringRate?: number;
  declare sellingWithEmail: boolean;
  declare sellingWithPhone: boolean;
  declare contactEmail?: string;
  declare contactPhone?: string;
  declare cargoTypes?: string;
  declare fmcsaData?: string;
  declare authorityHistory?: string;
  declare insuranceHistory?: string;
  declare insuranceCompany?: string;
  declare monthlyInsurancePremium?: number;
  declare views: number;
  declare saves: number;
  declare reviewNotes?: string;
  declare rejectionReason?: string;
  declare reviewedBy?: string;
  declare reviewedAt?: Date;
  declare publishedAt?: Date;
  declare soldAt?: Date;
  declare sellerId: string;
  declare listingFeePaid: boolean;
  declare readonly createdAt: Date;
  declare readonly updatedAt: Date;

  // Associations
  declare readonly seller?: User;
  declare readonly documents?: Document[];
  declare readonly offers?: Offer[];
}

Listing.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    mcNumber: {
      type: DataTypes.STRING(50),
      allowNull: false,
    },
    dotNumber: {
      type: DataTypes.STRING(50),
      allowNull: false,
    },
    legalName: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    dbaName: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    title: {
      type: DataTypes.STRING(500),
      allowNull: false,
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    askingPrice: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: false,
      comment: 'Price the seller is asking for the MC authority',
    },
    listingPrice: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: true,
      comment: 'Published price set by admin (shown to buyers)',
    },
    isPremium: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    isVip: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    freeToUnlock: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
      comment: 'If true, buyers with any active subscription can unlock without spending a credit',
    },
    status: {
      type: DataTypes.ENUM(...Object.values(ListingStatus)),
      defaultValue: ListingStatus.DRAFT,
    },
    visibility: {
      type: DataTypes.ENUM(...Object.values(ListingVisibility)),
      defaultValue: ListingVisibility.PUBLIC,
    },
    city: {
      type: DataTypes.STRING(100),
      allowNull: false,
    },
    state: {
      type: DataTypes.STRING(50),
      allowNull: false,
    },
    address: {
      type: DataTypes.STRING(500),
      allowNull: true,
    },
    yearsActive: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    fleetSize: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    totalDrivers: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    safetyRating: {
      type: DataTypes.ENUM(...Object.values(SafetyRating)),
      defaultValue: SafetyRating.NONE,
    },
    saferScore: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    insuranceOnFile: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    bipdCoverage: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: true,
    },
    cargoCoverage: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: true,
    },
    bondAmount: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: true,
    },
    amazonStatus: {
      type: DataTypes.ENUM(...Object.values(AmazonRelayStatus)),
      defaultValue: AmazonRelayStatus.NONE,
    },
    amazonRelayScore: {
      type: DataTypes.STRING(10),
      allowNull: true,
    },
    authorityType: {
      type: DataTypes.ENUM(...Object.values(AuthorityType)),
      defaultValue: AuthorityType.MOTOR_CARRIER,
      allowNull: false,
      comment: 'What type of authority is being sold (motor carrier, broker, both, or freight forwarder)',
    },
    highwaySetup: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    hasFactoring: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    factoringCompany: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    factoringRate: {
      type: DataTypes.DECIMAL(5, 2),
      allowNull: true,
    },
    sellingWithEmail: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    sellingWithPhone: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    contactEmail: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    contactPhone: {
      type: DataTypes.STRING(50),
      allowNull: true,
    },
    cargoTypes: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    fmcsaData: {
      type: DataTypes.TEXT('long'),
      allowNull: true,
    },
    authorityHistory: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    insuranceHistory: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    insuranceCompany: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    monthlyInsurancePremium: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: true,
    },
    views: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    saves: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    reviewNotes: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    rejectionReason: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    reviewedBy: {
      type: DataTypes.UUID,
      allowNull: true,
    },
    reviewedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    publishedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    soldAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    sellerId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    listingFeePaid: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
      allowNull: false,
      comment: 'Tracks whether the listing fee has been paid',
    },
  },
  {
    sequelize,
    tableName: 'listings',
    indexes: [
      // Single column indexes
      { fields: ['mcNumber'] },
      { fields: ['dotNumber'] },
      { fields: ['sellerId'] },
      { fields: ['status'] },
      { fields: ['state'] },
      { fields: ['askingPrice'] },
      { fields: ['listingPrice'] },
      { fields: ['isPremium'] },
      { fields: ['isVip'] },
      { fields: ['freeToUnlock'] },
      // Composite indexes for common search patterns (reduces query cost)
      { fields: ['status', 'visibility'], name: 'idx_listings_status_visibility' },
      { fields: ['status', 'state', 'isPremium', 'isVip'], name: 'idx_listings_search_filters' },
      { fields: ['sellerId', 'status'], name: 'idx_listings_seller_status' },
      { fields: ['status', 'createdAt'], name: 'idx_listings_status_created' },
    ],
  }
);

// ==================== DOCUMENT MODEL ====================

export class Document extends Model {
  declare id: string;
  declare type: DocumentType;
  declare name: string;
  declare url: string;
  declare size: number;
  declare mimeType: string;
  declare status: DocumentStatus;
  declare verifiedAt?: Date;
  declare verifiedBy?: string;
  declare listingId?: string;
  declare transactionId?: string;
  declare uploaderId: string;
  declare readonly createdAt: Date;
  declare readonly updatedAt: Date;

  // Associations
  declare readonly listing?: Listing;
  declare readonly transaction?: Transaction;
  declare readonly uploader?: User;
}

Document.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    type: {
      type: DataTypes.STRING(50),
      allowNull: false,
    },
    name: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    url: {
      type: DataTypes.STRING(1000),
      allowNull: false,
    },
    size: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    mimeType: {
      type: DataTypes.STRING(100),
      allowNull: false,
    },
    status: {
      type: DataTypes.ENUM(...Object.values(DocumentStatus)),
      defaultValue: DocumentStatus.PENDING,
    },
    verifiedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    verifiedBy: {
      type: DataTypes.UUID,
      allowNull: true,
    },
    listingId: {
      type: DataTypes.UUID,
      allowNull: true,
    },
    transactionId: {
      type: DataTypes.UUID,
      allowNull: true,
    },
    uploaderId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
  },
  {
    sequelize,
    tableName: 'documents',
    indexes: [
      { fields: ['listingId'] },
      { fields: ['transactionId'] },
      { fields: ['type'] },
    ],
  }
);

// ==================== OFFER MODEL ====================

export class Offer extends Model {
  declare id: string;
  declare amount: number;
  declare message?: string;
  declare status: OfferStatus;
  declare isBuyNow: boolean;
  declare counterAmount?: number;
  declare counterMessage?: string;
  declare counterAt?: Date;
  declare expiresAt?: Date;
  declare respondedAt?: Date;
  declare sellerAmount?: number;
  declare adminReviewedBy?: string;
  declare adminReviewedAt?: Date;
  declare adminNotes?: string;
  declare adminMessageToSeller?: string;
  declare listingId: string;
  declare buyerId: string;
  declare sellerId: string;
  declare readonly createdAt: Date;
  declare readonly updatedAt: Date;

  // Associations
  declare readonly listing?: Listing;
  declare readonly buyer?: User;
  declare readonly seller?: User;
  declare readonly transaction?: Transaction;
}

Offer.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    amount: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: false,
    },
    message: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    status: {
      type: DataTypes.ENUM(...Object.values(OfferStatus)),
      defaultValue: OfferStatus.PENDING,
    },
    isBuyNow: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    counterAmount: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: true,
    },
    counterMessage: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    counterAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    expiresAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    respondedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    listingId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    buyerId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    sellerId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    sellerAmount: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: true,
    },
    adminReviewedBy: {
      type: DataTypes.UUID,
      allowNull: true,
    },
    adminReviewedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    adminNotes: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    adminMessageToSeller: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
  },
  {
    sequelize,
    tableName: 'offers',
    indexes: [
      // Single column indexes
      { fields: ['listingId'] },
      { fields: ['buyerId'] },
      { fields: ['sellerId'] },
      { fields: ['status'] },
      // Composite indexes for common query patterns
      { fields: ['listingId', 'buyerId', 'status'], name: 'idx_offers_listing_buyer_status' },
      { fields: ['sellerId', 'status'], name: 'idx_offers_seller_status' },
      { fields: ['buyerId', 'status'], name: 'idx_offers_buyer_status' },
    ],
  }
);

// ==================== TRANSACTION MODEL ====================

export class Transaction extends Model {
  declare id: string;
  declare status: TransactionStatus;
  declare agreedPrice: number;
  declare sellerPayout?: number;
  declare depositAmount: number;
  declare platformFee?: number;
  declare finalPaymentAmount?: number;
  declare buyerApproved: boolean;
  declare buyerApprovedAt?: Date;
  declare sellerApproved: boolean;
  declare sellerApprovedAt?: Date;
  declare adminApproved: boolean;
  declare adminApprovedAt?: Date;
  declare buyerAcceptedTerms: boolean;
  declare buyerAcceptedTermsAt?: Date;
  declare sellerAcceptedTerms: boolean;
  declare sellerAcceptedTermsAt?: Date;
  declare depositPaidAt?: Date;
  declare depositPaymentMethod?: PaymentMethod;
  declare depositPaymentRef?: string;
  declare finalPaidAt?: Date;
  declare finalPaymentMethod?: PaymentMethod;
  declare finalPaymentRef?: string;
  declare escrowStatus?: string;
  declare escrowAmount?: number;
  declare escrowConfirmedAt?: Date;
  declare escrowConfirmedBy?: string;
  declare escrowPaymentMethod?: string;
  declare escrowReleaseAt?: Date;
  declare disputeReason?: string;
  declare disputeOpenedAt?: Date;
  declare disputeResolvedAt?: Date;
  declare disputeResolution?: string;
  declare buyerNotes?: string;
  declare sellerNotes?: string;
  declare adminNotes?: string;
  declare payoutStatus?: string;
  declare payoutReleasedAt?: Date;
  declare payoutTransferId?: string;
  declare completedAt?: Date;
  declare cancelledAt?: Date;
  declare listingId: string;
  declare offerId: string;
  declare buyerId: string;
  declare sellerId: string;
  declare adminId?: string;
  declare readonly createdAt: Date;
  declare readonly updatedAt: Date;

  // Associations
  declare readonly listing?: Listing;
  declare readonly offer?: Offer;
  declare readonly buyer?: User;
  declare readonly seller?: User;
  declare readonly admin?: User;
  declare readonly documents?: Document[];
  declare readonly messages?: TransactionMessage[];
  declare readonly timeline?: TransactionTimeline[];
  declare readonly payments?: Payment[];
}

Transaction.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    status: {
      type: DataTypes.ENUM(...Object.values(TransactionStatus)),
      defaultValue: TransactionStatus.AWAITING_DEPOSIT,
    },
    agreedPrice: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: false,
    },
    sellerPayout: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: true,
    },
    depositAmount: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: false,
    },
    platformFee: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: true,
    },
    finalPaymentAmount: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: true,
    },
    buyerApproved: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    buyerApprovedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    sellerApproved: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    sellerApprovedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    adminApproved: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    adminApprovedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    buyerAcceptedTerms: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    buyerAcceptedTermsAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    sellerAcceptedTerms: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    sellerAcceptedTermsAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    depositPaidAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    depositPaymentMethod: {
      type: DataTypes.ENUM(...Object.values(PaymentMethod)),
      allowNull: true,
    },
    depositPaymentRef: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    finalPaidAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    finalPaymentMethod: {
      type: DataTypes.ENUM(...Object.values(PaymentMethod)),
      allowNull: true,
    },
    finalPaymentRef: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    escrowStatus: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    escrowAmount: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: true,
    },
    escrowConfirmedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    escrowConfirmedBy: {
      type: DataTypes.UUID,
      allowNull: true,
    },
    escrowPaymentMethod: {
      type: DataTypes.STRING(50),
      allowNull: true,
    },
    escrowReleaseAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    disputeReason: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    disputeOpenedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    disputeResolvedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    disputeResolution: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    buyerNotes: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    sellerNotes: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    adminNotes: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    payoutStatus: {
      type: DataTypes.STRING(20),
      allowNull: true,
      defaultValue: null,
    },
    payoutReleasedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    payoutTransferId: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    completedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    cancelledAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    listingId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    offerId: {
      type: DataTypes.UUID,
      allowNull: false,
      unique: true,
    },
    buyerId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    sellerId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    adminId: {
      type: DataTypes.UUID,
      allowNull: true,
    },
  },
  {
    sequelize,
    tableName: 'transactions',
    indexes: [
      // Single column indexes
      { fields: ['listingId'] },
      { fields: ['buyerId'] },
      { fields: ['sellerId'] },
      { fields: ['status'] },
      // Composite indexes for common query patterns
      { fields: ['buyerId', 'status'], name: 'idx_transactions_buyer_status' },
      { fields: ['sellerId', 'status'], name: 'idx_transactions_seller_status' },
    ],
  }
);

// ==================== TRANSACTION MESSAGE MODEL ====================

export class TransactionMessage extends Model {
  declare id: string;
  declare content: string;
  declare senderRole: UserRole;
  declare senderId: string;
  declare transactionId: string;
  declare readonly createdAt: Date;
}

TransactionMessage.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    content: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    senderRole: {
      type: DataTypes.ENUM(...Object.values(UserRole)),
      allowNull: false,
    },
    senderId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    transactionId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
  },
  {
    sequelize,
    tableName: 'transaction_messages',
    updatedAt: false,
    indexes: [{ fields: ['transactionId'] }],
  }
);

// ==================== TRANSACTION TIMELINE MODEL ====================

export class TransactionTimeline extends Model {
  declare id: string;
  declare status: TransactionStatus;
  declare title: string;
  declare description?: string;
  declare actorId?: string;
  declare actorRole?: UserRole;
  declare transactionId: string;
  declare readonly createdAt: Date;
}

TransactionTimeline.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    status: {
      type: DataTypes.ENUM(...Object.values(TransactionStatus)),
      allowNull: false,
    },
    title: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    actorId: {
      type: DataTypes.UUID,
      allowNull: true,
    },
    actorRole: {
      type: DataTypes.ENUM(...Object.values(UserRole)),
      allowNull: true,
    },
    transactionId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
  },
  {
    sequelize,
    tableName: 'transaction_timeline',
    updatedAt: false,
    indexes: [{ fields: ['transactionId'] }],
  }
);

// ==================== PAYMENT MODEL ====================

export class Payment extends Model {
  declare id: string;
  declare type: PaymentType;
  declare amount: number;
  declare status: PaymentStatus;
  declare method?: PaymentMethod;
  declare stripePaymentId?: string;
  declare stripeIntentId?: string;
  declare reference?: string;
  declare verifiedBy?: string;
  declare verifiedAt?: Date;
  declare description?: string;
  declare metadata?: string;
  declare completedAt?: Date;
  declare transactionId?: string;
  declare userId?: string;
  declare readonly createdAt: Date;
  declare readonly updatedAt: Date;
}

Payment.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    type: {
      type: DataTypes.ENUM(...Object.values(PaymentType)),
      allowNull: false,
    },
    amount: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: false,
    },
    status: {
      type: DataTypes.ENUM(...Object.values(PaymentStatus)),
      defaultValue: PaymentStatus.PENDING,
    },
    method: {
      type: DataTypes.ENUM(...Object.values(PaymentMethod)),
      allowNull: true,
    },
    stripePaymentId: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    stripeIntentId: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    reference: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    verifiedBy: {
      type: DataTypes.UUID,
      allowNull: true,
    },
    verifiedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    metadata: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    completedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    transactionId: {
      type: DataTypes.UUID,
      allowNull: true,
    },
    userId: {
      type: DataTypes.UUID,
      allowNull: true,
    },
  },
  {
    sequelize,
    tableName: 'payments',
    indexes: [
      { fields: ['transactionId'] },
      { fields: ['status'] },
      { fields: ['type'] },
    ],
  }
);

// ==================== TRANSACTION CREDENTIAL MODEL ====================

export class TransactionCredential extends Model {
  declare id: string;
  declare transactionId: string;
  declare label: string;
  declare encryptedUsername: string | null;
  declare encryptedPassword: string;
  declare iv: string;
  declare authTag: string;
  declare ivUsername: string | null;
  declare authTagUsername: string | null;
  declare releasedToBuyer: boolean;
  declare releasedAt: Date | null;
  declare releasedBy: string | null;
  declare createdBy: string;
  declare readonly createdAt: Date;
  declare readonly updatedAt: Date;

  // Associations
  declare readonly transaction?: Transaction;
  declare readonly creator?: User;
}

TransactionCredential.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    transactionId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: 'transactions', key: 'id' },
    },
    label: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    encryptedUsername: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    encryptedPassword: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    iv: {
      type: DataTypes.STRING(32),
      allowNull: false,
    },
    authTag: {
      type: DataTypes.STRING(32),
      allowNull: false,
    },
    ivUsername: {
      type: DataTypes.STRING(32),
      allowNull: true,
    },
    authTagUsername: {
      type: DataTypes.STRING(32),
      allowNull: true,
    },
    releasedToBuyer: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    releasedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    releasedBy: {
      type: DataTypes.UUID,
      allowNull: true,
    },
    createdBy: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: 'users', key: 'id' },
    },
  },
  {
    sequelize,
    tableName: 'transaction_credentials',
    timestamps: true,
    indexes: [
      { fields: ['transactionId'] },
    ],
  }
);

// ==================== REVIEW MODEL ====================

export class Review extends Model {
  declare id: string;
  declare rating: number;
  declare comment?: string;
  declare fromUserId: string;
  declare toUserId: string;
  declare dealId?: string;
  declare readonly createdAt: Date;
  declare readonly updatedAt: Date;
}

Review.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    rating: {
      type: DataTypes.INTEGER,
      allowNull: false,
      validate: { min: 1, max: 5 },
    },
    comment: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    fromUserId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    toUserId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    dealId: {
      type: DataTypes.UUID,
      allowNull: true,
    },
  },
  {
    sequelize,
    tableName: 'reviews',
    indexes: [
      { fields: ['toUserId'] },
      { unique: true, fields: ['fromUserId', 'toUserId', 'dealId'] },
    ],
  }
);

// ==================== SAVED LISTING MODEL ====================

export class SavedListing extends Model {
  declare id: string;
  declare userId: string;
  declare listingId: string;
  declare readonly createdAt: Date;

  // Associations
  declare readonly user?: User;
  declare readonly listing?: Listing;
}

SavedListing.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    userId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    listingId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
  },
  {
    sequelize,
    tableName: 'saved_listings',
    updatedAt: false,
    indexes: [
      { fields: ['userId'] },
      { fields: ['listingId'] },
      { unique: true, fields: ['userId', 'listingId'] },
    ],
  }
);

// ==================== UNLOCKED LISTING MODEL ====================

export class UnlockedListing extends Model {
  declare id: string;
  declare creditsUsed: number;
  declare userId: string;
  declare listingId: string;
  declare readonly createdAt: Date;

  // Associations
  declare readonly user?: User;
  declare readonly listing?: Listing;
}

UnlockedListing.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    creditsUsed: {
      type: DataTypes.INTEGER,
      defaultValue: 1,
    },
    userId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    listingId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
  },
  {
    sequelize,
    tableName: 'unlocked_listings',
    updatedAt: false,
    indexes: [
      { fields: ['userId'] },
      { fields: ['listingId'] },
      { unique: true, fields: ['userId', 'listingId'] },
    ],
  }
);

// ==================== CREDIT TRANSACTION MODEL ====================

export class CreditTransaction extends Model {
  declare id: string;
  declare type: CreditTransactionType;
  declare amount: number;
  declare balance: number;
  declare description?: string;
  declare reference?: string;
  declare userId: string;
  declare readonly createdAt: Date;
}

CreditTransaction.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    type: {
      type: DataTypes.ENUM(...Object.values(CreditTransactionType)),
      allowNull: false,
    },
    amount: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    balance: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    reference: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    userId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
  },
  {
    sequelize,
    tableName: 'credit_transactions',
    updatedAt: false,
    indexes: [
      { fields: ['userId'] },
      { fields: ['type'] },
    ],
  }
);

// ==================== SUBSCRIPTION MODEL ====================

export class Subscription extends Model {
  declare id: string;
  declare plan: SubscriptionPlan;
  declare status: SubscriptionStatus;
  declare priceMonthly: number;
  declare priceYearly?: number;
  declare isYearly: boolean;
  declare creditsPerMonth: number;
  declare creditsRemaining: number;
  declare stripeSubId?: string;
  declare stripeCustomerId?: string;
  declare startDate: Date;
  declare endDate?: Date;
  declare renewalDate?: Date;
  declare cancelledAt?: Date;
  declare userId: string;
  declare readonly createdAt: Date;
  declare readonly updatedAt: Date;

  // Associations
  declare readonly user?: User;
}

Subscription.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    plan: {
      type: DataTypes.ENUM(...Object.values(SubscriptionPlan)),
      allowNull: false,
    },
    status: {
      type: DataTypes.ENUM(...Object.values(SubscriptionStatus)),
      defaultValue: SubscriptionStatus.ACTIVE,
    },
    priceMonthly: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
    },
    priceYearly: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: true,
    },
    isYearly: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    creditsPerMonth: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    creditsRemaining: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    stripeSubId: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    stripeCustomerId: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    startDate: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    },
    endDate: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    renewalDate: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    cancelledAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    userId: {
      type: DataTypes.UUID,
      allowNull: false,
      unique: true,
    },
  },
  {
    sequelize,
    tableName: 'subscriptions',
    indexes: [{ fields: ['status'] }],
  }
);

// ==================== MESSAGE MODEL ====================

export class Message extends Model {
  declare id: string;
  declare content: string;
  declare read: boolean;
  declare readAt?: Date;
  declare senderId: string;
  declare receiverId: string;
  declare listingId?: string;
  declare readonly createdAt: Date;

  // Associations
  declare readonly sender?: User;
  declare readonly receiver?: User;
  declare readonly listing?: Listing;
}

Message.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    content: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    read: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    readAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    senderId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    receiverId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    listingId: {
      type: DataTypes.UUID,
      allowNull: true,
    },
  },
  {
    sequelize,
    tableName: 'messages',
    updatedAt: false,
    indexes: [
      { fields: ['senderId'] },
      { fields: ['receiverId'] },
      { fields: ['read'] },
    ],
  }
);

// ==================== NOTIFICATION MODEL ====================

export class Notification extends Model {
  declare id: string;
  declare type: NotificationType;
  declare title: string;
  declare message: string;
  declare read: boolean;
  declare readAt?: Date;
  declare link?: string;
  declare metadata?: string;
  declare userId: string;
  declare readonly createdAt: Date;
}

Notification.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    type: {
      type: DataTypes.ENUM(...Object.values(NotificationType)),
      allowNull: false,
    },
    title: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    message: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    read: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    readAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    link: {
      type: DataTypes.STRING(500),
      allowNull: true,
    },
    metadata: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    userId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
  },
  {
    sequelize,
    tableName: 'notifications',
    updatedAt: false,
    indexes: [
      { fields: ['userId'] },
      { fields: ['read'] },
      { fields: ['type'] },
    ],
  }
);

// ==================== PREMIUM REQUEST MODEL ====================

export class PremiumRequest extends Model {
  declare id: string;
  declare status: PremiumRequestStatus;
  declare message?: string;
  declare adminNotes?: string;
  declare contactedAt?: Date;
  declare contactedBy?: string;
  declare buyerId: string;
  declare listingId: string;
  declare readonly createdAt: Date;
  declare readonly updatedAt: Date;

  // Associations (populated when included in queries)
  declare buyer?: User;
  declare listing?: Listing;
}

PremiumRequest.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    status: {
      type: DataTypes.ENUM(...Object.values(PremiumRequestStatus)),
      defaultValue: PremiumRequestStatus.PENDING,
    },
    message: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    adminNotes: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    contactedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    contactedBy: {
      type: DataTypes.UUID,
      allowNull: true,
    },
    buyerId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    listingId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
  },
  {
    sequelize,
    tableName: 'premium_requests',
    indexes: [
      { fields: ['status'] },
      { unique: true, fields: ['buyerId', 'listingId'] },
    ],
  }
);

// ==================== ADMIN ACTION MODEL ====================

export class AdminAction extends Model {
  declare id: string;
  declare action: string;
  declare targetType: string;
  declare targetId: string;
  declare reason?: string;
  declare metadata?: string;
  declare adminId: string;
  declare readonly createdAt: Date;
}

AdminAction.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    action: {
      type: DataTypes.STRING(100),
      allowNull: false,
    },
    targetType: {
      type: DataTypes.STRING(50),
      allowNull: false,
    },
    targetId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    reason: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    metadata: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    adminId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
  },
  {
    sequelize,
    tableName: 'admin_actions',
    updatedAt: false,
    indexes: [
      { fields: ['adminId'] },
      { fields: ['targetType'] },
      { fields: ['targetId'] },
    ],
  }
);

// ==================== PLATFORM SETTING MODEL ====================

export class PlatformSetting extends Model {
  declare id: string;
  declare key: string;
  declare value: string;
  declare type: string;
  declare readonly createdAt: Date;
  declare readonly updatedAt: Date;
}

PlatformSetting.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    key: {
      type: DataTypes.STRING(100),
      allowNull: false,
      unique: true,
    },
    value: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    type: {
      type: DataTypes.STRING(20),
      defaultValue: 'string',
    },
  },
  {
    sequelize,
    tableName: 'platform_settings',
  }
);

// ==================== CONSULTATION MODEL ====================

export class Consultation extends Model {
  declare id: string;
  declare name: string;
  declare email: string;
  declare phone: string;
  declare preferredDate: string;
  declare preferredTime: string;
  declare message?: string;
  declare status: ConsultationStatus;
  declare amount: number;
  declare stripeSessionId?: string;
  declare stripePaymentIntentId?: string;
  declare paidAt?: Date;
  declare scheduledAt?: Date;
  declare completedAt?: Date;
  declare adminNotes?: string;
  declare contactedBy?: string;
  declare contactedAt?: Date;
  declare readonly createdAt: Date;
  declare readonly updatedAt: Date;
}

Consultation.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    name: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    email: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    phone: {
      type: DataTypes.STRING(50),
      allowNull: false,
    },
    preferredDate: {
      type: DataTypes.STRING(20),
      allowNull: false,
    },
    preferredTime: {
      type: DataTypes.STRING(20),
      allowNull: false,
    },
    message: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    status: {
      type: DataTypes.ENUM(...Object.values(ConsultationStatus)),
      defaultValue: ConsultationStatus.PENDING_PAYMENT,
    },
    amount: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
      defaultValue: 100.00,
    },
    stripeSessionId: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    stripePaymentIntentId: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    paidAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    scheduledAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    completedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    adminNotes: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    contactedBy: {
      type: DataTypes.UUID,
      allowNull: true,
    },
    contactedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  },
  {
    sequelize,
    tableName: 'consultations',
    indexes: [
      { fields: ['email'] },
      { fields: ['status'] },
      { fields: ['stripeSessionId'] },
      { fields: ['createdAt'] },
    ],
  }
);

// ==================== ACCOUNT DISPUTE MODEL ====================

export class AccountDispute extends Model {
  declare id: string;
  declare userId: string;
  declare stripeTransactionId: string;
  declare cardholderName: string;
  declare userName: string;
  declare status: AccountDisputeStatus;
  declare disputeEmail?: string;
  declare disputeInfo?: string;
  declare disputeReason?: string;
  declare submittedAt?: Date;
  declare autoUnblockAt?: Date;
  declare resolvedAt?: Date;
  declare resolvedBy?: string;
  declare adminNotes?: string;
  declare readonly createdAt: Date;
  declare readonly updatedAt: Date;

  // Associations
  declare readonly user?: User;
  declare readonly resolver?: User;
}

AccountDispute.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    userId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    stripeTransactionId: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    cardholderName: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    userName: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    status: {
      type: DataTypes.ENUM(...Object.values(AccountDisputeStatus)),
      defaultValue: AccountDisputeStatus.PENDING,
    },
    disputeEmail: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    disputeInfo: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    disputeReason: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    submittedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    autoUnblockAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    resolvedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    resolvedBy: {
      type: DataTypes.UUID,
      allowNull: true,
    },
    adminNotes: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
  },
  {
    sequelize,
    tableName: 'account_disputes',
    indexes: [
      { fields: ['userId'] },
      { fields: ['status'] },
      { fields: ['stripeTransactionId'] },
      { fields: ['autoUnblockAt'] },
    ],
  }
);

// ==================== USER TERMS ACCEPTANCE MODEL ====================
// Tracks when users accept the Terms of Service - required for premium requests

export class UserTermsAcceptance extends Model {
  declare id: string;
  declare userId: string;
  declare termsVersion: string;
  declare signatureName: string;
  declare acceptedAt: Date;
  declare ipAddress?: string;
  declare userAgent?: string;
  declare pdfUrl?: string;
  declare emailedToAdminAt?: Date;
  declare readonly createdAt: Date;

  // Associations
  declare readonly user?: User;
}

UserTermsAcceptance.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    userId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    termsVersion: {
      type: DataTypes.STRING(20),
      allowNull: false,
      defaultValue: '1.0',
    },
    signatureName: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    acceptedAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    ipAddress: {
      type: DataTypes.STRING(45),
      allowNull: true,
    },
    userAgent: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    pdfUrl: {
      type: DataTypes.STRING(500),
      allowNull: true,
    },
    emailedToAdminAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  },
  {
    sequelize,
    tableName: 'user_terms_acceptances',
    updatedAt: false,
    indexes: [
      { unique: true, fields: ['userId', 'termsVersion'] },
      { fields: ['userId'] },
      { fields: ['acceptedAt'] },
    ],
  }
);

// ==================== PDF PURCHASE MODEL ====================
// Tracks one-time PDF / bundle purchases via Stripe Payment Links

export enum PdfPurchaseTier {
  PDF = 'pdf',
  PDF_PLUS_60DAY = 'pdf_plus_60day',
}

export class PdfPurchase extends Model {
  declare id: string;
  declare email: string;
  declare stripeSessionId: string;
  declare tier: PdfPurchaseTier;
  declare downloadToken: string;
  declare downloadCount: number;
  declare lastDownloadedAt: Date | undefined;
  declare userId: string | undefined;
  declare amountCents: number | undefined;
  declare readonly createdAt: Date;
  declare readonly updatedAt: Date;
}

PdfPurchase.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    email: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    stripeSessionId: {
      type: DataTypes.STRING(255),
      allowNull: false,
      unique: true,
    },
    tier: {
      type: DataTypes.STRING(32),
      allowNull: false,
    },
    downloadToken: {
      type: DataTypes.STRING(128),
      allowNull: false,
      unique: true,
    },
    downloadCount: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    lastDownloadedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    userId: {
      type: DataTypes.UUID,
      allowNull: true,
    },
    amountCents: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
  },
  {
    sequelize,
    tableName: 'pdf_purchases',
    indexes: [
      { fields: ['email'] },
      { unique: true, fields: ['downloadToken'] },
      { unique: true, fields: ['stripeSessionId'] },
      { fields: ['userId'] },
    ],
  }
);

// ==================== PROCESSED WEBHOOK EVENT MODEL ====================
// Used for webhook idempotency - prevents duplicate processing of Stripe events

export class ProcessedWebhookEvent extends Model {
  declare id: string;
  declare eventId: string;
  declare eventType: string;
  declare processedAt: Date;
  declare readonly createdAt: Date;
}

ProcessedWebhookEvent.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    eventId: {
      type: DataTypes.STRING(255),
      allowNull: false,
      unique: true,
    },
    eventType: {
      type: DataTypes.STRING(100),
      allowNull: false,
    },
    processedAt: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    },
  },
  {
    sequelize,
    tableName: 'processed_webhook_events',
    updatedAt: false,
    indexes: [
      { unique: true, fields: ['eventId'] },
      { fields: ['eventType'] },
      { fields: ['processedAt'] },
    ],
  }
);

// ==================== BUYER PREFERENCES MODEL ====================

export class BuyerPreferences extends Model {
  declare id: string;
  declare userId: string;
  declare minPrice?: number | null;
  declare maxPrice?: number | null;
  declare preferredStates?: string[] | null;
  declare cargoTypes?: string[] | null;
  declare minYearsActive?: number | null;
  declare minFleetSize?: number | null;
  declare preferredSafetyRating?: SafetyRating | null;
  declare needsAmazon?: boolean | null;
  declare minAmazonRelayScore?: string | null;
  declare needsHighway?: boolean | null;
  declare needsFactoring?: boolean | null;
  declare needsRmis?: boolean | null;
  declare needsEmail?: boolean | null;
  declare needsPhone?: boolean | null;
  declare needsInsurance?: boolean | null;
  declare buyerNotes?: string | null;
  declare adminNotes?: string | null;
  declare lastEditedBy?: 'BUYER' | 'ADMIN' | null;
  declare lastEditedAt?: Date | null;
  declare readonly createdAt: Date;
  declare readonly updatedAt: Date;

  declare readonly user?: User;
}

BuyerPreferences.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    userId: {
      type: DataTypes.UUID,
      allowNull: false,
      unique: true,
    },
    minPrice: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
    maxPrice: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
    preferredStates: { type: DataTypes.JSON, allowNull: true },
    cargoTypes: { type: DataTypes.JSON, allowNull: true },
    minYearsActive: { type: DataTypes.INTEGER, allowNull: true },
    minFleetSize: { type: DataTypes.INTEGER, allowNull: true },
    preferredSafetyRating: {
      type: DataTypes.ENUM(...Object.values(SafetyRating)),
      allowNull: true,
    },
    needsAmazon: { type: DataTypes.BOOLEAN, allowNull: true },
    minAmazonRelayScore: { type: DataTypes.STRING(2), allowNull: true },
    needsHighway: { type: DataTypes.BOOLEAN, allowNull: true },
    needsFactoring: { type: DataTypes.BOOLEAN, allowNull: true },
    needsRmis: { type: DataTypes.BOOLEAN, allowNull: true },
    needsEmail: { type: DataTypes.BOOLEAN, allowNull: true },
    needsPhone: { type: DataTypes.BOOLEAN, allowNull: true },
    needsInsurance: { type: DataTypes.BOOLEAN, allowNull: true },
    buyerNotes: { type: DataTypes.TEXT, allowNull: true },
    adminNotes: { type: DataTypes.TEXT, allowNull: true },
    lastEditedBy: {
      type: DataTypes.ENUM('BUYER', 'ADMIN'),
      allowNull: true,
    },
    lastEditedAt: { type: DataTypes.DATE, allowNull: true },
  },
  {
    sequelize,
    tableName: 'buyer_preferences',
    indexes: [{ unique: true, fields: ['userId'] }],
  }
);

// ==================== MATCH NOTIFICATION SENT MODEL ====================
// Dedupe table so a buyer is never emailed twice about the same listing.

export type MatchNotificationReason = 'amazon' | 'score';

export class MatchNotificationSent extends Model {
  declare id: string;
  declare buyerId: string;
  declare listingId: string;
  declare reason: MatchNotificationReason;
  declare matchScore?: number | null;
  declare readonly sentAt: Date;
}

MatchNotificationSent.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    buyerId: { type: DataTypes.UUID, allowNull: false },
    listingId: { type: DataTypes.UUID, allowNull: false },
    reason: {
      type: DataTypes.ENUM('amazon', 'score'),
      allowNull: false,
    },
    matchScore: { type: DataTypes.INTEGER, allowNull: true },
    sentAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
  },
  {
    sequelize,
    tableName: 'match_notifications_sent',
    timestamps: false,
    indexes: [
      { unique: true, fields: ['buyerId', 'listingId', 'reason'] },
      { fields: ['listingId'] },
      { fields: ['buyerId'] },
    ],
  }
);

// ==================== TRUCK MODELS ====================
// A listing can optionally include one or more trucks (the physical asset)
// being sold together with the motor carrier authority.

export class Truck extends Model {
  declare id: string;
  declare listingId: string;
  declare make: string;
  declare model: string;
  declare year?: number | null;
  declare mileage?: number | null;
  declare vin?: string | null;
  declare condition?: TruckCondition | null;
  declare description?: string | null;
  declare displayOrder: number;
  declare readonly createdAt: Date;
  declare readonly updatedAt: Date;

  declare readonly photos?: TruckPhoto[];
}

Truck.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    listingId: { type: DataTypes.UUID, allowNull: false },
    make: { type: DataTypes.STRING(100), allowNull: false },
    model: { type: DataTypes.STRING(100), allowNull: false },
    year: { type: DataTypes.INTEGER, allowNull: true },
    mileage: { type: DataTypes.INTEGER, allowNull: true },
    vin: { type: DataTypes.STRING(32), allowNull: true },
    condition: {
      type: DataTypes.ENUM(...Object.values(TruckCondition)),
      allowNull: true,
    },
    description: { type: DataTypes.TEXT, allowNull: true },
    displayOrder: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
  },
  {
    sequelize,
    tableName: 'trucks',
    indexes: [{ fields: ['listingId'] }],
  }
);

export class TruckPhoto extends Model {
  declare id: string;
  declare truckId: string;
  declare url: string;
  declare filename?: string | null;
  declare displayOrder: number;
  declare readonly createdAt: Date;
}

TruckPhoto.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    truckId: { type: DataTypes.UUID, allowNull: false },
    url: { type: DataTypes.STRING(1000), allowNull: false },
    filename: { type: DataTypes.STRING(255), allowNull: true },
    displayOrder: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
  },
  {
    sequelize,
    tableName: 'truck_photos',
    updatedAt: false,
    indexes: [{ fields: ['truckId'] }],
  }
);

// ==================== ASSOCIATIONS ====================

// User associations
User.hasMany(Listing, { foreignKey: 'sellerId', as: 'listings' });
User.hasMany(Offer, { foreignKey: 'buyerId', as: 'sentOffers' });
User.hasMany(Offer, { foreignKey: 'sellerId', as: 'receivedOffers' });
User.hasMany(Transaction, { foreignKey: 'buyerId', as: 'buyerTransactions' });
User.hasMany(Transaction, { foreignKey: 'sellerId', as: 'sellerTransactions' });
User.hasMany(Transaction, { foreignKey: 'adminId', as: 'adminTransactions' });
User.hasMany(Review, { foreignKey: 'fromUserId', as: 'reviewsGiven' });
User.hasMany(Review, { foreignKey: 'toUserId', as: 'reviewsReceived' });
User.hasMany(SavedListing, { foreignKey: 'userId', as: 'savedListings' });
User.hasMany(UnlockedListing, { foreignKey: 'userId', as: 'unlockedListings' });
User.hasMany(CreditTransaction, { foreignKey: 'userId', as: 'creditHistory' });
User.hasOne(Subscription, { foreignKey: 'userId', as: 'subscription' });
User.hasOne(BuyerPreferences, { foreignKey: 'userId', as: 'preferences' });
BuyerPreferences.belongsTo(User, { foreignKey: 'userId', as: 'user' });
User.hasMany(Message, { foreignKey: 'senderId', as: 'sentMessages' });
User.hasMany(Message, { foreignKey: 'receiverId', as: 'receivedMessages' });
User.hasMany(Notification, { foreignKey: 'userId', as: 'notifications' });
User.hasMany(Document, { foreignKey: 'uploaderId', as: 'documents' });
User.hasMany(PremiumRequest, { foreignKey: 'buyerId', as: 'premiumRequests' });
User.hasMany(AdminAction, { foreignKey: 'adminId', as: 'adminActions' });
User.hasMany(RefreshToken, { foreignKey: 'userId', as: 'refreshTokens' });

// RefreshToken associations
RefreshToken.belongsTo(User, { foreignKey: 'userId', as: 'user' });

// PasswordResetToken associations
PasswordResetToken.belongsTo(User, { foreignKey: 'userId', as: 'user' });
User.hasMany(PasswordResetToken, { foreignKey: 'userId', as: 'passwordResetTokens' });

// EmailVerificationToken associations
EmailVerificationToken.belongsTo(User, { foreignKey: 'userId', as: 'user' });
User.hasMany(EmailVerificationToken, { foreignKey: 'userId', as: 'emailVerificationTokens' });

// Listing associations
Listing.belongsTo(User, { foreignKey: 'sellerId', as: 'seller' });
Listing.hasMany(Document, { foreignKey: 'listingId', as: 'documents' });
Listing.hasMany(Offer, { foreignKey: 'listingId', as: 'offers' });
Listing.hasMany(Transaction, { foreignKey: 'listingId', as: 'transactions' });
Listing.hasMany(SavedListing, { foreignKey: 'listingId', as: 'savedBy' });
Listing.hasMany(UnlockedListing, { foreignKey: 'listingId', as: 'unlockedBy' });
Listing.hasMany(PremiumRequest, { foreignKey: 'listingId', as: 'premiumRequests' });
Listing.hasMany(Truck, { foreignKey: 'listingId', as: 'trucks' });

// Truck associations
Truck.belongsTo(Listing, { foreignKey: 'listingId', as: 'listing' });
Truck.hasMany(TruckPhoto, { foreignKey: 'truckId', as: 'photos' });
TruckPhoto.belongsTo(Truck, { foreignKey: 'truckId', as: 'truck' });

// Document associations
Document.belongsTo(Listing, { foreignKey: 'listingId', as: 'listing' });
Document.belongsTo(Transaction, { foreignKey: 'transactionId', as: 'transaction' });
Document.belongsTo(User, { foreignKey: 'uploaderId', as: 'uploader' });

// Offer associations
Offer.belongsTo(Listing, { foreignKey: 'listingId', as: 'listing' });
Offer.belongsTo(User, { foreignKey: 'buyerId', as: 'buyer' });
Offer.belongsTo(User, { foreignKey: 'sellerId', as: 'seller' });
Offer.hasOne(Transaction, { foreignKey: 'offerId', as: 'transaction' });

// Transaction associations
Transaction.belongsTo(Listing, { foreignKey: 'listingId', as: 'listing' });
Transaction.belongsTo(Offer, { foreignKey: 'offerId', as: 'offer' });
Transaction.belongsTo(User, { foreignKey: 'buyerId', as: 'buyer' });
Transaction.belongsTo(User, { foreignKey: 'sellerId', as: 'seller' });
Transaction.belongsTo(User, { foreignKey: 'adminId', as: 'admin' });
Transaction.hasMany(Document, { foreignKey: 'transactionId', as: 'documents' });
Transaction.hasMany(TransactionMessage, { foreignKey: 'transactionId', as: 'messages' });
Transaction.hasMany(TransactionTimeline, { foreignKey: 'transactionId', as: 'timeline' });
Transaction.hasMany(Payment, { foreignKey: 'transactionId', as: 'payments' });
Transaction.hasMany(TransactionCredential, { foreignKey: 'transactionId', as: 'credentials' });

// TransactionCredential associations
TransactionCredential.belongsTo(Transaction, { foreignKey: 'transactionId', as: 'transaction' });
TransactionCredential.belongsTo(User, { foreignKey: 'createdBy', as: 'creator' });

// TransactionMessage associations
TransactionMessage.belongsTo(Transaction, { foreignKey: 'transactionId', as: 'transaction' });

// TransactionTimeline associations
TransactionTimeline.belongsTo(Transaction, { foreignKey: 'transactionId', as: 'transaction' });

// Payment associations
Payment.belongsTo(Transaction, { foreignKey: 'transactionId', as: 'transaction' });

// Review associations
Review.belongsTo(User, { foreignKey: 'fromUserId', as: 'fromUser' });
Review.belongsTo(User, { foreignKey: 'toUserId', as: 'toUser' });

// SavedListing associations
SavedListing.belongsTo(User, { foreignKey: 'userId', as: 'user' });
SavedListing.belongsTo(Listing, { foreignKey: 'listingId', as: 'listing' });

// UnlockedListing associations
UnlockedListing.belongsTo(User, { foreignKey: 'userId', as: 'user' });
UnlockedListing.belongsTo(Listing, { foreignKey: 'listingId', as: 'listing' });

// CreditTransaction associations
CreditTransaction.belongsTo(User, { foreignKey: 'userId', as: 'user' });

// Subscription associations
Subscription.belongsTo(User, { foreignKey: 'userId', as: 'user' });

// Message associations
Message.belongsTo(User, { foreignKey: 'senderId', as: 'sender' });
Message.belongsTo(User, { foreignKey: 'receiverId', as: 'receiver' });

// Notification associations
Notification.belongsTo(User, { foreignKey: 'userId', as: 'user' });

// PremiumRequest associations
PremiumRequest.belongsTo(User, { foreignKey: 'buyerId', as: 'buyer' });
PremiumRequest.belongsTo(Listing, { foreignKey: 'listingId', as: 'listing' });

// AdminAction associations
AdminAction.belongsTo(User, { foreignKey: 'adminId', as: 'admin' });

// AccountDispute associations
AccountDispute.belongsTo(User, { foreignKey: 'userId', as: 'user' });
AccountDispute.belongsTo(User, { foreignKey: 'resolvedBy', as: 'resolver' });
User.hasMany(AccountDispute, { foreignKey: 'userId', as: 'accountDisputes' });

// UserTermsAcceptance associations
UserTermsAcceptance.belongsTo(User, { foreignKey: 'userId', as: 'user' });
User.hasMany(UserTermsAcceptance, { foreignKey: 'userId', as: 'termsAcceptances' });

// Export all models
export {
  sequelize,
};

export default {
  User,
  RefreshToken,
  PasswordResetToken,
  EmailVerificationToken,
  Listing,
  Document,
  Offer,
  Transaction,
  TransactionMessage,
  TransactionTimeline,
  Payment,
  Review,
  SavedListing,
  UnlockedListing,
  CreditTransaction,
  Subscription,
  BuyerPreferences,
  MatchNotificationSent,
  Truck,
  TruckPhoto,
  Message,
  Notification,
  PremiumRequest,
  AdminAction,
  PlatformSetting,
  Consultation,
  AccountDispute,
  ProcessedWebhookEvent,
  UserTermsAcceptance,
  PdfPurchase,
  sequelize,
};
