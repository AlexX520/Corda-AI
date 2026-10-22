-- Outlook sign-in handshake stored in the database (works on serverless hosts)
CREATE TABLE "OutlookAuthState" (
    "state" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "verifier" TEXT NOT NULL,
    "appOrigin" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OutlookAuthState_pkey" PRIMARY KEY ("state")
);
