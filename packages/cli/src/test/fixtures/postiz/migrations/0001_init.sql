CREATE TABLE "Organization" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "apiKey" TEXT,
    "paymentId" TEXT,
    "streakSince" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    "allowTrial" BOOLEAN NOT NULL DEFAULT false,
    "isTrailing" BOOLEAN NOT NULL DEFAULT false,
    "shortlink" TEXT NOT NULL DEFAULT 'ASK'
);
--> statement-breakpoint
CREATE TABLE "Tags" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "deletedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Tags_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
--> statement-breakpoint
CREATE TABLE "TagsPosts" (
    "postId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,

    PRIMARY KEY ("postId", "tagId"),
    CONSTRAINT "TagsPosts_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "TagsPosts_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tags" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
--> statement-breakpoint
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "password" TEXT,
    "providerName" TEXT NOT NULL,
    "name" TEXT,
    "lastName" TEXT,
    "isSuperAdmin" BOOLEAN NOT NULL DEFAULT false,
    "bio" TEXT,
    "audience" INTEGER NOT NULL DEFAULT 0,
    "pictureId" TEXT,
    "providerId" TEXT,
    "timezone" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "lastReadNotifications" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inviteId" TEXT,
    "activated" BOOLEAN NOT NULL DEFAULT true,
    "account" TEXT,
    "connectedAccount" BOOLEAN NOT NULL DEFAULT false,
    "lastOnline" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip" TEXT,
    "agent" TEXT,
    "deletedAt" DATETIME,
    "sendSuccessEmails" BOOLEAN NOT NULL DEFAULT true,
    "sendFailureEmails" BOOLEAN NOT NULL DEFAULT true,
    "sendStreakEmails" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "User_pictureId_fkey" FOREIGN KEY ("pictureId") REFERENCES "Media" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
--> statement-breakpoint
CREATE TABLE "UsedCodes" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "UsedCodes_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
--> statement-breakpoint
CREATE TABLE "UserOrganization" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "disabled" BOOLEAN NOT NULL DEFAULT false,
    "role" TEXT NOT NULL DEFAULT 'USER',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "UserOrganization_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "UserOrganization_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
--> statement-breakpoint
CREATE TABLE "GitHub" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "login" TEXT,
    "name" TEXT,
    "token" TEXT NOT NULL,
    "jobId" TEXT,
    "organizationId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "GitHub_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
--> statement-breakpoint
CREATE TABLE "Trending" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "trendingList" TEXT NOT NULL,
    "language" TEXT,
    "hash" TEXT NOT NULL,
    "date" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
--> statement-breakpoint
CREATE TABLE "TrendingLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "language" TEXT,
    "date" DATETIME NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ItemUser" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    CONSTRAINT "ItemUser_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
--> statement-breakpoint
CREATE TABLE "Star" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "stars" INTEGER NOT NULL,
    "totalStars" INTEGER NOT NULL,
    "forks" INTEGER NOT NULL,
    "totalForks" INTEGER NOT NULL,
    "login" TEXT NOT NULL,
    "date" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
--> statement-breakpoint
CREATE TABLE "Media" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "originalName" TEXT,
    "path" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    "fileSize" INTEGER NOT NULL DEFAULT 0,
    "type" TEXT NOT NULL DEFAULT 'image',
    "thumbnail" TEXT,
    "alt" TEXT,
    "thumbnailTimestamp" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'ready',
    "processingError" TEXT,
    CONSTRAINT "Media_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
--> statement-breakpoint
CREATE TABLE "SocialMediaAgency" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "logoId" TEXT,
    "website" TEXT,
    "slug" TEXT,
    "facebook" TEXT,
    "instagram" TEXT,
    "twitter" TEXT,
    "linkedIn" TEXT,
    "youtube" TEXT,
    "tiktok" TEXT,
    "otherSocialMedia" TEXT,
    "shortDescription" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "approved" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    CONSTRAINT "SocialMediaAgency_logoId_fkey" FOREIGN KEY ("logoId") REFERENCES "Media" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "SocialMediaAgency_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
--> statement-breakpoint
CREATE TABLE "SocialMediaAgencyNiche" (
    "agencyId" TEXT NOT NULL,
    "niche" TEXT NOT NULL,

    PRIMARY KEY ("agencyId", "niche"),
    CONSTRAINT "SocialMediaAgencyNiche_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "SocialMediaAgency" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
--> statement-breakpoint
CREATE TABLE "Credits" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "credits" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'ai_images',
    CONSTRAINT "Credits_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
--> statement-breakpoint
CREATE TABLE "Clipping" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'analysing',
    "error" TEXT,
    "title" TEXT,
    "thumbnail" TEXT,
    "duration" INTEGER,
    "maxClips" INTEGER NOT NULL DEFAULT 5,
    "fit" TEXT NOT NULL DEFAULT 'blur',
    "integrations" TEXT NOT NULL,
    "creditsId" TEXT,
    "deletedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Clipping_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
--> statement-breakpoint
CREATE TABLE "ClippingClip" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clippingId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "start" REAL NOT NULL,
    "end" REAL NOT NULL,
    "trimStart" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "error" TEXT,
    "mediaId" TEXT,
    "path" TEXT,
    "thumbnail" TEXT,
    "draftedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ClippingClip_clippingId_fkey" FOREIGN KEY ("clippingId") REFERENCES "Clipping" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
--> statement-breakpoint
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "subscriptionTier" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'stripe',
    "identifier" TEXT,
    "cancelAt" DATETIME,
    "period" TEXT NOT NULL,
    "totalChannels" INTEGER NOT NULL,
    "isLifetime" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    CONSTRAINT "Subscription_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
--> statement-breakpoint
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    CONSTRAINT "Customer_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
--> statement-breakpoint
CREATE TABLE "Integration" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "internalId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "customName" TEXT,
    "picture" TEXT,
    "providerIdentifier" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "disabled" BOOLEAN NOT NULL DEFAULT false,
    "tokenExpiration" DATETIME,
    "refreshToken" TEXT,
    "profile" TEXT,
    "deletedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME,
    "inBetweenSteps" BOOLEAN NOT NULL DEFAULT false,
    "refreshNeeded" BOOLEAN NOT NULL DEFAULT false,
    "postingTimes" TEXT NOT NULL DEFAULT '[{"time":120}, {"time":400}, {"time":700}]',
    "customInstanceDetails" TEXT,
    "customerId" TEXT,
    "rootInternalId" TEXT,
    "additionalSettings" TEXT DEFAULT '[]',
    CONSTRAINT "Integration_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Integration_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
--> statement-breakpoint
CREATE TABLE "Signatures" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "autoAdd" BOOLEAN NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    CONSTRAINT "Signatures_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
--> statement-breakpoint
CREATE TABLE "Comments" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "content" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "userId" TEXT,
    "displayName" TEXT,
    "parentId" TEXT,
    "anchorStart" INTEGER,
    "anchorEnd" INTEGER,
    "anchorQuote" TEXT,
    "resolvedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    CONSTRAINT "Comments_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Comments_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Comments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Comments_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Comments" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
--> statement-breakpoint
CREATE TABLE "Post" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "state" TEXT NOT NULL DEFAULT 'QUEUE',
    "publishDate" DATETIME NOT NULL,
    "organizationId" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "delay" INTEGER NOT NULL DEFAULT 0,
    "group" TEXT NOT NULL,
    "batchId" TEXT,
    "title" TEXT,
    "description" TEXT,
    "parentPostId" TEXT,
    "releaseId" TEXT,
    "releaseURL" TEXT,
    "settings" TEXT,
    "image" TEXT,
    "submittedForOrderId" TEXT,
    "submittedForOrganizationId" TEXT,
    "approvedSubmitForOrder" TEXT NOT NULL DEFAULT 'NO',
    "creationMethod" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "lastMessageId" TEXT,
    "intervalInDays" INTEGER,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    CONSTRAINT "Post_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "Integration" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Post_lastMessageId_fkey" FOREIGN KEY ("lastMessageId") REFERENCES "Messages" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Post_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Post_parentPostId_fkey" FOREIGN KEY ("parentPostId") REFERENCES "Post" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Post_submittedForOrderId_fkey" FOREIGN KEY ("submittedForOrderId") REFERENCES "Orders" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Post_submittedForOrganizationId_fkey" FOREIGN KEY ("submittedForOrganizationId") REFERENCES "Organization" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
--> statement-breakpoint
CREATE TABLE "Notifications" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "link" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    CONSTRAINT "Notifications_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
--> statement-breakpoint
CREATE TABLE "MessagesGroup" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "buyerOrganizationId" TEXT NOT NULL,
    "buyerId" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "MessagesGroup_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "MessagesGroup_buyerOrganizationId_fkey" FOREIGN KEY ("buyerOrganizationId") REFERENCES "Organization" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "MessagesGroup_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
--> statement-breakpoint
CREATE TABLE "PayoutProblems" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "status" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "postId" TEXT,
    "amount" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PayoutProblems_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Orders" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PayoutProblems_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "PayoutProblems_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
--> statement-breakpoint
CREATE TABLE "Orders" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "buyerId" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "messageGroupId" TEXT NOT NULL,
    "captureId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Orders_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Orders_messageGroupId_fkey" FOREIGN KEY ("messageGroupId") REFERENCES "MessagesGroup" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Orders_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
--> statement-breakpoint
CREATE TABLE "OrderItems" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orderId" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "price" INTEGER NOT NULL,
    CONSTRAINT "OrderItems_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "Integration" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "OrderItems_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Orders" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
--> statement-breakpoint
CREATE TABLE "Messages" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "from" TEXT NOT NULL,
    "content" TEXT,
    "groupId" TEXT NOT NULL,
    "special" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    CONSTRAINT "Messages_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "MessagesGroup" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
--> statement-breakpoint
CREATE TABLE "Plugs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "plugFunction" TEXT NOT NULL,
    "data" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "activated" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "Plugs_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "Integration" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Plugs_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
--> statement-breakpoint
CREATE TABLE "ExisingPlugData" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "integrationId" TEXT NOT NULL,
    "methodName" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    CONSTRAINT "ExisingPlugData_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "Integration" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
--> statement-breakpoint
CREATE TABLE "PopularPosts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "category" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "hook" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
--> statement-breakpoint
CREATE TABLE "IntegrationsWebhooks" (
    "integrationId" TEXT NOT NULL,
    "webhookId" TEXT NOT NULL,

    PRIMARY KEY ("integrationId", "webhookId"),
    CONSTRAINT "IntegrationsWebhooks_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "Integration" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "IntegrationsWebhooks_webhookId_fkey" FOREIGN KEY ("webhookId") REFERENCES "Webhooks" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
--> statement-breakpoint
CREATE TABLE "Webhooks" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "deletedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Webhooks_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
--> statement-breakpoint
CREATE TABLE "AutoPost" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT,
    "onSlot" BOOLEAN NOT NULL,
    "syncLast" BOOLEAN NOT NULL,
    "url" TEXT NOT NULL,
    "lastUrl" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL,
    "addPicture" BOOLEAN NOT NULL,
    "generateContent" BOOLEAN NOT NULL,
    "integrations" TEXT NOT NULL,
    "deletedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AutoPost_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
--> statement-breakpoint
CREATE TABLE "Sets" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Sets_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
--> statement-breakpoint
CREATE TABLE "ThirdParty" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "internalId" TEXT NOT NULL,
    "apiKey" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    CONSTRAINT "ThirdParty_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
--> statement-breakpoint
CREATE TABLE "Errors" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "message" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "postId" TEXT NOT NULL,
    "body" TEXT NOT NULL DEFAULT '{}',
    CONSTRAINT "Errors_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Errors_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
--> statement-breakpoint
CREATE TABLE "Mentions" (
    "name" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "image" TEXT NOT NULL,

    PRIMARY KEY ("name", "username", "platform", "image")
);
--> statement-breakpoint
CREATE TABLE "OAuthApp" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "pictureId" TEXT,
    "redirectUrl" TEXT NOT NULL,
    "redirectUris" TEXT,
    "clientId" TEXT NOT NULL,
    "clientSecret" TEXT,
    "dynamic" BOOLEAN NOT NULL DEFAULT false,
    "tokenEndpointAuthMethod" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    CONSTRAINT "OAuthApp_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "OAuthApp_pictureId_fkey" FOREIGN KEY ("pictureId") REFERENCES "Media" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
--> statement-breakpoint
CREATE TABLE "OAuthAuthorization" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "oauthAppId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "accessToken" TEXT,
    "authorizationCode" TEXT,
    "codeExpiresAt" DATETIME,
    "codeChallenge" TEXT,
    "codeChallengeMethod" TEXT,
    "redirectUri" TEXT,
    "revokedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "OAuthAuthorization_oauthAppId_fkey" FOREIGN KEY ("oauthAppId") REFERENCES "OAuthApp" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "OAuthAuthorization_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "OAuthAuthorization_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
--> statement-breakpoint
CREATE TABLE "OAuthSelfHostedAuthorization" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "oauthAppId" TEXT NOT NULL,
    "mcpUrl" TEXT NOT NULL,
    "apiKey" TEXT NOT NULL,
    "email" TEXT,
    "accessToken" TEXT,
    "authorizationCode" TEXT,
    "codeExpiresAt" DATETIME,
    "codeChallenge" TEXT,
    "codeChallengeMethod" TEXT,
    "redirectUri" TEXT,
    "revokedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "OAuthSelfHostedAuthorization_oauthAppId_fkey" FOREIGN KEY ("oauthAppId") REFERENCES "OAuthApp" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
--> statement-breakpoint
CREATE TABLE "Announcement" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT 'INFO',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE INDEX "Organization_apiKey_idx" ON "Organization"("apiKey");
--> statement-breakpoint
CREATE INDEX "Organization_streakSince_idx" ON "Organization"("streakSince");
--> statement-breakpoint
CREATE INDEX "Organization_paymentId_idx" ON "Organization"("paymentId");
--> statement-breakpoint
CREATE INDEX "Organization_deletedAt_idx" ON "Organization"("deletedAt");
--> statement-breakpoint
CREATE INDEX "Tags_orgId_idx" ON "Tags"("orgId");
--> statement-breakpoint
CREATE INDEX "Tags_deletedAt_idx" ON "Tags"("deletedAt");
--> statement-breakpoint
CREATE UNIQUE INDEX "TagsPosts_postId_tagId_key" ON "TagsPosts"("postId", "tagId");
--> statement-breakpoint
CREATE INDEX "User_lastReadNotifications_idx" ON "User"("lastReadNotifications");
--> statement-breakpoint
CREATE INDEX "User_inviteId_idx" ON "User"("inviteId");
--> statement-breakpoint
CREATE INDEX "User_account_idx" ON "User"("account");
--> statement-breakpoint
CREATE INDEX "User_lastOnline_idx" ON "User"("lastOnline");
--> statement-breakpoint
CREATE INDEX "User_pictureId_idx" ON "User"("pictureId");
--> statement-breakpoint
CREATE INDEX "User_deletedAt_idx" ON "User"("deletedAt");
--> statement-breakpoint
CREATE UNIQUE INDEX "User_email_providerName_key" ON "User"("email", "providerName");
--> statement-breakpoint
CREATE INDEX "UsedCodes_code_idx" ON "UsedCodes"("code");
--> statement-breakpoint
CREATE INDEX "UserOrganization_organizationId_idx" ON "UserOrganization"("organizationId");
--> statement-breakpoint
CREATE INDEX "UserOrganization_disabled_idx" ON "UserOrganization"("disabled");
--> statement-breakpoint
CREATE UNIQUE INDEX "UserOrganization_userId_organizationId_key" ON "UserOrganization"("userId", "organizationId");
--> statement-breakpoint
CREATE INDEX "GitHub_login_idx" ON "GitHub"("login");
--> statement-breakpoint
CREATE INDEX "GitHub_organizationId_idx" ON "GitHub"("organizationId");
--> statement-breakpoint
CREATE UNIQUE INDEX "Trending_language_key" ON "Trending"("language");
--> statement-breakpoint
CREATE INDEX "Trending_hash_idx" ON "Trending"("hash");
--> statement-breakpoint
CREATE INDEX "ItemUser_userId_idx" ON "ItemUser"("userId");
--> statement-breakpoint
CREATE INDEX "ItemUser_key_idx" ON "ItemUser"("key");
--> statement-breakpoint
CREATE UNIQUE INDEX "ItemUser_userId_key_key" ON "ItemUser"("userId", "key");
--> statement-breakpoint
CREATE UNIQUE INDEX "Star_login_date_key" ON "Star"("login", "date");
--> statement-breakpoint
CREATE INDEX "Media_name_idx" ON "Media"("name");
--> statement-breakpoint
CREATE INDEX "Media_organizationId_idx" ON "Media"("organizationId");
--> statement-breakpoint
CREATE INDEX "Media_type_idx" ON "Media"("type");
--> statement-breakpoint
CREATE UNIQUE INDEX "SocialMediaAgency_userId_key" ON "SocialMediaAgency"("userId");
--> statement-breakpoint
CREATE INDEX "SocialMediaAgency_userId_idx" ON "SocialMediaAgency"("userId");
--> statement-breakpoint
CREATE INDEX "SocialMediaAgency_deletedAt_idx" ON "SocialMediaAgency"("deletedAt");
--> statement-breakpoint
CREATE INDEX "SocialMediaAgency_id_idx" ON "SocialMediaAgency"("id");
--> statement-breakpoint
CREATE INDEX "Credits_organizationId_idx" ON "Credits"("organizationId");
--> statement-breakpoint
CREATE INDEX "Credits_createdAt_idx" ON "Credits"("createdAt");
--> statement-breakpoint
CREATE INDEX "Clipping_organizationId_idx" ON "Clipping"("organizationId");
--> statement-breakpoint
CREATE INDEX "Clipping_deletedAt_idx" ON "Clipping"("deletedAt");
--> statement-breakpoint
CREATE INDEX "ClippingClip_clippingId_idx" ON "ClippingClip"("clippingId");
--> statement-breakpoint
CREATE UNIQUE INDEX "Subscription_organizationId_key" ON "Subscription"("organizationId");
--> statement-breakpoint
CREATE INDEX "Subscription_organizationId_idx" ON "Subscription"("organizationId");
--> statement-breakpoint
CREATE INDEX "Subscription_deletedAt_idx" ON "Subscription"("deletedAt");
--> statement-breakpoint
CREATE UNIQUE INDEX "Customer_orgId_name_deletedAt_key" ON "Customer"("orgId", "name", "deletedAt");
--> statement-breakpoint
CREATE INDEX "Integration_rootInternalId_idx" ON "Integration"("rootInternalId");
--> statement-breakpoint
CREATE INDEX "Integration_organizationId_idx" ON "Integration"("organizationId");
--> statement-breakpoint
CREATE INDEX "Integration_providerIdentifier_idx" ON "Integration"("providerIdentifier");
--> statement-breakpoint
CREATE INDEX "Integration_updatedAt_idx" ON "Integration"("updatedAt");
--> statement-breakpoint
CREATE INDEX "Integration_createdAt_idx" ON "Integration"("createdAt");
--> statement-breakpoint
CREATE INDEX "Integration_deletedAt_idx" ON "Integration"("deletedAt");
--> statement-breakpoint
CREATE INDEX "Integration_customerId_idx" ON "Integration"("customerId");
--> statement-breakpoint
CREATE INDEX "Integration_inBetweenSteps_idx" ON "Integration"("inBetweenSteps");
--> statement-breakpoint
CREATE INDEX "Integration_refreshNeeded_idx" ON "Integration"("refreshNeeded");
--> statement-breakpoint
CREATE INDEX "Integration_disabled_idx" ON "Integration"("disabled");
--> statement-breakpoint
CREATE UNIQUE INDEX "Integration_organizationId_internalId_key" ON "Integration"("organizationId", "internalId");
--> statement-breakpoint
CREATE INDEX "Signatures_createdAt_idx" ON "Signatures"("createdAt");
--> statement-breakpoint
CREATE INDEX "Signatures_organizationId_idx" ON "Signatures"("organizationId");
--> statement-breakpoint
CREATE INDEX "Signatures_deletedAt_idx" ON "Signatures"("deletedAt");
--> statement-breakpoint
CREATE INDEX "Comments_createdAt_idx" ON "Comments"("createdAt");
--> statement-breakpoint
CREATE INDEX "Comments_organizationId_idx" ON "Comments"("organizationId");
--> statement-breakpoint
CREATE INDEX "Comments_userId_idx" ON "Comments"("userId");
--> statement-breakpoint
CREATE INDEX "Comments_postId_idx" ON "Comments"("postId");
--> statement-breakpoint
CREATE INDEX "Comments_parentId_idx" ON "Comments"("parentId");
--> statement-breakpoint
CREATE INDEX "Comments_resolvedAt_idx" ON "Comments"("resolvedAt");
--> statement-breakpoint
CREATE INDEX "Comments_deletedAt_idx" ON "Comments"("deletedAt");
--> statement-breakpoint
CREATE INDEX "Post_group_idx" ON "Post"("group");
--> statement-breakpoint
CREATE INDEX "Post_batchId_idx" ON "Post"("batchId");
--> statement-breakpoint
CREATE INDEX "Post_deletedAt_idx" ON "Post"("deletedAt");
--> statement-breakpoint
CREATE INDEX "Post_publishDate_idx" ON "Post"("publishDate");
--> statement-breakpoint
CREATE INDEX "Post_state_idx" ON "Post"("state");
--> statement-breakpoint
CREATE INDEX "Post_organizationId_idx" ON "Post"("organizationId");
--> statement-breakpoint
CREATE INDEX "Post_parentPostId_idx" ON "Post"("parentPostId");
--> statement-breakpoint
CREATE INDEX "Post_submittedForOrderId_idx" ON "Post"("submittedForOrderId");
--> statement-breakpoint
CREATE INDEX "Post_intervalInDays_idx" ON "Post"("intervalInDays");
--> statement-breakpoint
CREATE INDEX "Post_approvedSubmitForOrder_idx" ON "Post"("approvedSubmitForOrder");
--> statement-breakpoint
CREATE INDEX "Post_creationMethod_idx" ON "Post"("creationMethod");
--> statement-breakpoint
CREATE INDEX "Post_lastMessageId_idx" ON "Post"("lastMessageId");
--> statement-breakpoint
CREATE INDEX "Post_createdAt_idx" ON "Post"("createdAt");
--> statement-breakpoint
CREATE INDEX "Post_updatedAt_idx" ON "Post"("updatedAt");
--> statement-breakpoint
CREATE INDEX "Post_releaseURL_idx" ON "Post"("releaseURL");
--> statement-breakpoint
CREATE INDEX "Post_integrationId_idx" ON "Post"("integrationId");
--> statement-breakpoint
CREATE INDEX "Notifications_createdAt_idx" ON "Notifications"("createdAt");
--> statement-breakpoint
CREATE INDEX "Notifications_organizationId_idx" ON "Notifications"("organizationId");
--> statement-breakpoint
CREATE INDEX "Notifications_deletedAt_idx" ON "Notifications"("deletedAt");
--> statement-breakpoint
CREATE INDEX "MessagesGroup_createdAt_idx" ON "MessagesGroup"("createdAt");
--> statement-breakpoint
CREATE INDEX "MessagesGroup_updatedAt_idx" ON "MessagesGroup"("updatedAt");
--> statement-breakpoint
CREATE INDEX "MessagesGroup_buyerOrganizationId_idx" ON "MessagesGroup"("buyerOrganizationId");
--> statement-breakpoint
CREATE UNIQUE INDEX "MessagesGroup_buyerId_sellerId_key" ON "MessagesGroup"("buyerId", "sellerId");
--> statement-breakpoint
CREATE INDEX "Orders_buyerId_idx" ON "Orders"("buyerId");
--> statement-breakpoint
CREATE INDEX "Orders_sellerId_idx" ON "Orders"("sellerId");
--> statement-breakpoint
CREATE INDEX "Orders_updatedAt_idx" ON "Orders"("updatedAt");
--> statement-breakpoint
CREATE INDEX "Orders_createdAt_idx" ON "Orders"("createdAt");
--> statement-breakpoint
CREATE INDEX "Orders_messageGroupId_idx" ON "Orders"("messageGroupId");
--> statement-breakpoint
CREATE INDEX "OrderItems_orderId_idx" ON "OrderItems"("orderId");
--> statement-breakpoint
CREATE INDEX "OrderItems_integrationId_idx" ON "OrderItems"("integrationId");
--> statement-breakpoint
CREATE INDEX "Messages_groupId_idx" ON "Messages"("groupId");
--> statement-breakpoint
CREATE INDEX "Messages_createdAt_idx" ON "Messages"("createdAt");
--> statement-breakpoint
CREATE INDEX "Messages_deletedAt_idx" ON "Messages"("deletedAt");
--> statement-breakpoint
CREATE INDEX "Plugs_organizationId_idx" ON "Plugs"("organizationId");
--> statement-breakpoint
CREATE UNIQUE INDEX "Plugs_plugFunction_integrationId_key" ON "Plugs"("plugFunction", "integrationId");
--> statement-breakpoint
CREATE UNIQUE INDEX "ExisingPlugData_integrationId_methodName_value_key" ON "ExisingPlugData"("integrationId", "methodName", "value");
--> statement-breakpoint
CREATE INDEX "IntegrationsWebhooks_integrationId_idx" ON "IntegrationsWebhooks"("integrationId");
--> statement-breakpoint
CREATE INDEX "IntegrationsWebhooks_webhookId_idx" ON "IntegrationsWebhooks"("webhookId");
--> statement-breakpoint
CREATE UNIQUE INDEX "IntegrationsWebhooks_integrationId_webhookId_key" ON "IntegrationsWebhooks"("integrationId", "webhookId");
--> statement-breakpoint
CREATE INDEX "Webhooks_organizationId_idx" ON "Webhooks"("organizationId");
--> statement-breakpoint
CREATE INDEX "Webhooks_deletedAt_idx" ON "Webhooks"("deletedAt");
--> statement-breakpoint
CREATE INDEX "AutoPost_deletedAt_idx" ON "AutoPost"("deletedAt");
--> statement-breakpoint
CREATE INDEX "Sets_organizationId_idx" ON "Sets"("organizationId");
--> statement-breakpoint
CREATE INDEX "ThirdParty_organizationId_idx" ON "ThirdParty"("organizationId");
--> statement-breakpoint
CREATE INDEX "ThirdParty_deletedAt_idx" ON "ThirdParty"("deletedAt");
--> statement-breakpoint
CREATE UNIQUE INDEX "ThirdParty_organizationId_internalId_key" ON "ThirdParty"("organizationId", "internalId");
--> statement-breakpoint
CREATE INDEX "Errors_organizationId_idx" ON "Errors"("organizationId");
--> statement-breakpoint
CREATE INDEX "Errors_createdAt_idx" ON "Errors"("createdAt");
--> statement-breakpoint
CREATE INDEX "Mentions_createdAt_idx" ON "Mentions"("createdAt");
--> statement-breakpoint
CREATE UNIQUE INDEX "OAuthApp_clientId_key" ON "OAuthApp"("clientId");
--> statement-breakpoint
CREATE INDEX "OAuthApp_clientId_idx" ON "OAuthApp"("clientId");
--> statement-breakpoint
CREATE INDEX "OAuthApp_organizationId_idx" ON "OAuthApp"("organizationId");
--> statement-breakpoint
CREATE INDEX "OAuthApp_deletedAt_idx" ON "OAuthApp"("deletedAt");
--> statement-breakpoint
CREATE INDEX "OAuthApp_dynamic_idx" ON "OAuthApp"("dynamic");
--> statement-breakpoint
CREATE UNIQUE INDEX "OAuthApp_organizationId_deletedAt_key" ON "OAuthApp"("organizationId", "deletedAt");
--> statement-breakpoint
CREATE INDEX "OAuthAuthorization_accessToken_idx" ON "OAuthAuthorization"("accessToken");
--> statement-breakpoint
CREATE INDEX "OAuthAuthorization_authorizationCode_idx" ON "OAuthAuthorization"("authorizationCode");
--> statement-breakpoint
CREATE INDEX "OAuthAuthorization_oauthAppId_idx" ON "OAuthAuthorization"("oauthAppId");
--> statement-breakpoint
CREATE INDEX "OAuthAuthorization_userId_idx" ON "OAuthAuthorization"("userId");
--> statement-breakpoint
CREATE INDEX "OAuthAuthorization_organizationId_idx" ON "OAuthAuthorization"("organizationId");
--> statement-breakpoint
CREATE INDEX "OAuthAuthorization_revokedAt_idx" ON "OAuthAuthorization"("revokedAt");
--> statement-breakpoint
CREATE UNIQUE INDEX "OAuthAuthorization_oauthAppId_userId_organizationId_key" ON "OAuthAuthorization"("oauthAppId", "userId", "organizationId");
--> statement-breakpoint
CREATE INDEX "OAuthSelfHostedAuthorization_accessToken_idx" ON "OAuthSelfHostedAuthorization"("accessToken");
--> statement-breakpoint
CREATE INDEX "OAuthSelfHostedAuthorization_authorizationCode_idx" ON "OAuthSelfHostedAuthorization"("authorizationCode");
--> statement-breakpoint
CREATE INDEX "OAuthSelfHostedAuthorization_oauthAppId_idx" ON "OAuthSelfHostedAuthorization"("oauthAppId");
