CREATE TYPE "CohortType" AS ENUM ('org_specific', 'open');

-- CreateEnum
CREATE TYPE "CohortStatus" AS ENUM ('draft', 'active', 'completed', 'archived');

-- CreateEnum
CREATE TYPE "OrgSize" AS ENUM ('solo', 'small', 'medium', 'large', 'enterprise');

-- CreateEnum
CREATE TYPE "ParticipantRequestStatus" AS ENUM ('pending', 'in_progress', 'submitted', 'reviewed', 'approved', 'rejected');

-- CreateEnum
CREATE TYPE "DeliverableStatus" AS ENUM ('pending', 'ready', 'delivered', 'acknowledged');

-- CreateEnum
CREATE TYPE "AnalyticsEventType" AS ENUM ('portal_login', 'resource_viewed', 'resource_downloaded', 'form_opened', 'form_submitted', 'deliverable_acknowledged', 'forum_post', 'forum_reply', 'timeline_milestone_reached', 'task_completed');
CREATE TABLE "Organisation" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "logoUrl" TEXT,
    "website" TEXT,
    "size" "OrgSize",
    "industry" TEXT,
    "address" TEXT,
    "contactName" TEXT,
    "contactEmail" TEXT,
    "contactPhone" TEXT,
    "parentOrganisationId" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organisation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganisationParticipant" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "participantId" TEXT NOT NULL,
    "role" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrganisationParticipant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Cohort" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "type" "CohortType" NOT NULL DEFAULT 'open',
    "status" "CohortStatus" NOT NULL DEFAULT 'draft',
    "organisationId" TEXT,
    "logoUrl" TEXT,
    "description" TEXT,
    "maxSize" INTEGER,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Cohort_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CohortProgramme" (
    "id" TEXT NOT NULL,
    "cohortId" TEXT NOT NULL,
    "programmeId" TEXT NOT NULL,
    "enrolledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CohortProgramme_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CohortParticipant" (
    "id" TEXT NOT NULL,
    "cohortId" TEXT NOT NULL,
    "participantId" TEXT NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "CohortParticipant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CohortEventFlow" (
    "id" TEXT NOT NULL,
    "cohortId" TEXT NOT NULL,
    "flow" JSONB NOT NULL DEFAULT '{}',
    "deployedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CohortEventFlow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ParticipantSession" (
    "id" TEXT NOT NULL,
    "participantId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ParticipantSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ParticipantMagicLink" (
    "id" TEXT NOT NULL,
    "participantId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ParticipantMagicLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProgrammeTimeline" (
    "id" TEXT NOT NULL,
    "programmeId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProgrammeTimeline_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TimelineMilestone" (
    "id" TEXT NOT NULL,
    "timelineId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "order" INTEGER NOT NULL DEFAULT 0,
    "metadata" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "TimelineMilestone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ParticipantRequest" (
    "id" TEXT NOT NULL,
    "programmeId" TEXT,
    "cohortId" TEXT,
    "participantId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "dueDate" TIMESTAMP(3),
    "status" "ParticipantRequestStatus" NOT NULL DEFAULT 'pending',
    "formId" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ParticipantRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ParticipantRequestResponse" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ParticipantRequestResponse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Deliverable" (
    "id" TEXT NOT NULL,
    "programmeId" TEXT,
    "cohortId" TEXT,
    "participantId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "resourceType" "ResourceType" NOT NULL DEFAULT 'document',
    "url" TEXT,
    "status" "DeliverableStatus" NOT NULL DEFAULT 'pending',
    "scheduledAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "acknowledgedAt" TIMESTAMP(3),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Deliverable_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CohortCommsChannel" (
    "id" TEXT NOT NULL,
    "cohortId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CohortCommsChannel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CohortCommsThread" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "isPinned" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CohortCommsThread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CohortCommsReply" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "parentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CohortCommsReply_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProgrammeParticipantCommsChannel" (
    "id" TEXT NOT NULL,
    "programmeId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProgrammeParticipantCommsChannel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProgrammeParticipantCommsThread" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "isPinned" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProgrammeParticipantCommsThread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProgrammeParticipantCommsReply" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "parentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProgrammeParticipantCommsReply_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RegistrationPage" (
    "id" TEXT NOT NULL,
    "cohortId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT,
    "logoUrl" TEXT,
    "steps" JSONB NOT NULL DEFAULT '[]',
    "isPublished" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMP(3),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RegistrationPage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RegistrationSubmission" (
    "id" TEXT NOT NULL,
    "registrationPageId" TEXT NOT NULL,
    "participantId" TEXT,
    "answers" JSONB NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RegistrationSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnalyticsEvent" (
    "id" TEXT NOT NULL,
    "type" "AnalyticsEventType" NOT NULL,
    "participantId" TEXT,
    "cohortId" TEXT,
    "programmeId" TEXT,
    "organisationId" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnalyticsEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganisationAnalytics" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "metrics" JSONB NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrganisationAnalytics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CohortAnalytics" (
    "id" TEXT NOT NULL,
    "cohortId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "metrics" JSONB NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CohortAnalytics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ParticipantProgress" (
    "id" TEXT NOT NULL,
    "participantId" TEXT NOT NULL,
    "programmeId" TEXT NOT NULL,
    "cohortId" TEXT,
    "completionPct" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "milestonesHit" INTEGER NOT NULL DEFAULT 0,
    "formsSubmitted" INTEGER NOT NULL DEFAULT 0,
    "requestsDone" INTEGER NOT NULL DEFAULT 0,
    "lastActiveAt" TIMESTAMP(3),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ParticipantProgress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CohortResource" (
    "id" TEXT NOT NULL,
    "cohortId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "type" "ResourceType" NOT NULL DEFAULT 'link',
    "description" TEXT,
    "addedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CohortResource_pkey" PRIMARY KEY ("id")
CREATE UNIQUE INDEX "Organisation_slug_key" ON "Organisation"("slug");

-- CreateIndex
CREATE INDEX "Organisation_parentOrganisationId_idx" ON "Organisation"("parentOrganisationId");

-- CreateIndex
CREATE INDEX "OrganisationParticipant_participantId_idx" ON "OrganisationParticipant"("participantId");

-- CreateIndex
CREATE UNIQUE INDEX "OrganisationParticipant_organisationId_participantId_key" ON "OrganisationParticipant"("organisationId", "participantId");

-- CreateIndex
CREATE UNIQUE INDEX "Cohort_slug_key" ON "Cohort"("slug");

-- CreateIndex
CREATE INDEX "Cohort_organisationId_idx" ON "Cohort"("organisationId");

-- CreateIndex
CREATE INDEX "CohortProgramme_programmeId_idx" ON "CohortProgramme"("programmeId");

-- CreateIndex
CREATE UNIQUE INDEX "CohortProgramme_cohortId_programmeId_key" ON "CohortProgramme"("cohortId", "programmeId");

-- CreateIndex
CREATE INDEX "CohortParticipant_participantId_idx" ON "CohortParticipant"("participantId");

-- CreateIndex
CREATE UNIQUE INDEX "CohortParticipant_cohortId_participantId_key" ON "CohortParticipant"("cohortId", "participantId");

-- CreateIndex
CREATE UNIQUE INDEX "CohortEventFlow_cohortId_key" ON "CohortEventFlow"("cohortId");

-- CreateIndex
CREATE UNIQUE INDEX "ParticipantSession_tokenHash_key" ON "ParticipantSession"("tokenHash");

-- CreateIndex
CREATE INDEX "ParticipantSession_participantId_idx" ON "ParticipantSession"("participantId");

-- CreateIndex
CREATE INDEX "ParticipantSession_expiresAt_idx" ON "ParticipantSession"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "ParticipantMagicLink_tokenHash_key" ON "ParticipantMagicLink"("tokenHash");

-- CreateIndex
CREATE INDEX "ParticipantMagicLink_participantId_idx" ON "ParticipantMagicLink"("participantId");

-- CreateIndex
CREATE INDEX "ParticipantMagicLink_expiresAt_idx" ON "ParticipantMagicLink"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProgrammeTimeline_programmeId_key" ON "ProgrammeTimeline"("programmeId");

-- CreateIndex
CREATE INDEX "TimelineMilestone_timelineId_idx" ON "TimelineMilestone"("timelineId");

-- CreateIndex
CREATE INDEX "ParticipantRequest_participantId_idx" ON "ParticipantRequest"("participantId");

-- CreateIndex
CREATE INDEX "ParticipantRequest_programmeId_idx" ON "ParticipantRequest"("programmeId");

-- CreateIndex
CREATE INDEX "ParticipantRequest_cohortId_idx" ON "ParticipantRequest"("cohortId");

-- CreateIndex
CREATE UNIQUE INDEX "ParticipantRequestResponse_requestId_key" ON "ParticipantRequestResponse"("requestId");

-- CreateIndex
CREATE INDEX "Deliverable_programmeId_idx" ON "Deliverable"("programmeId");

-- CreateIndex
CREATE INDEX "Deliverable_cohortId_idx" ON "Deliverable"("cohortId");

-- CreateIndex
CREATE INDEX "Deliverable_participantId_idx" ON "Deliverable"("participantId");

-- CreateIndex
CREATE UNIQUE INDEX "CohortCommsChannel_cohortId_key" ON "CohortCommsChannel"("cohortId");

-- CreateIndex
CREATE INDEX "CohortCommsThread_channelId_idx" ON "CohortCommsThread"("channelId");

-- CreateIndex
CREATE INDEX "CohortCommsThread_authorId_idx" ON "CohortCommsThread"("authorId");

-- CreateIndex
CREATE INDEX "CohortCommsThread_createdAt_idx" ON "CohortCommsThread"("createdAt");

-- CreateIndex
CREATE INDEX "CohortCommsReply_threadId_idx" ON "CohortCommsReply"("threadId");

-- CreateIndex
CREATE INDEX "CohortCommsReply_authorId_idx" ON "CohortCommsReply"("authorId");

-- CreateIndex
CREATE UNIQUE INDEX "ProgrammeParticipantCommsChannel_programmeId_key" ON "ProgrammeParticipantCommsChannel"("programmeId");

-- CreateIndex
CREATE INDEX "ProgrammeParticipantCommsThread_channelId_idx" ON "ProgrammeParticipantCommsThread"("channelId");

-- CreateIndex
CREATE INDEX "ProgrammeParticipantCommsThread_authorId_idx" ON "ProgrammeParticipantCommsThread"("authorId");

-- CreateIndex
CREATE INDEX "ProgrammeParticipantCommsThread_createdAt_idx" ON "ProgrammeParticipantCommsThread"("createdAt");

-- CreateIndex
CREATE INDEX "ProgrammeParticipantCommsReply_threadId_idx" ON "ProgrammeParticipantCommsReply"("threadId");

-- CreateIndex
CREATE INDEX "ProgrammeParticipantCommsReply_authorId_idx" ON "ProgrammeParticipantCommsReply"("authorId");

-- CreateIndex
CREATE UNIQUE INDEX "RegistrationPage_slug_key" ON "RegistrationPage"("slug");

-- CreateIndex
CREATE INDEX "RegistrationPage_cohortId_idx" ON "RegistrationPage"("cohortId");

-- CreateIndex
CREATE INDEX "RegistrationSubmission_registrationPageId_idx" ON "RegistrationSubmission"("registrationPageId");

-- CreateIndex
CREATE INDEX "RegistrationSubmission_participantId_idx" ON "RegistrationSubmission"("participantId");

-- CreateIndex
CREATE INDEX "AnalyticsEvent_participantId_idx" ON "AnalyticsEvent"("participantId");

-- CreateIndex
CREATE INDEX "AnalyticsEvent_cohortId_idx" ON "AnalyticsEvent"("cohortId");

-- CreateIndex
CREATE INDEX "AnalyticsEvent_programmeId_idx" ON "AnalyticsEvent"("programmeId");

-- CreateIndex
CREATE INDEX "AnalyticsEvent_organisationId_idx" ON "AnalyticsEvent"("organisationId");

-- CreateIndex
CREATE INDEX "AnalyticsEvent_occurredAt_idx" ON "AnalyticsEvent"("occurredAt");

-- CreateIndex
CREATE INDEX "AnalyticsEvent_type_idx" ON "AnalyticsEvent"("type");

-- CreateIndex
CREATE INDEX "OrganisationAnalytics_organisationId_idx" ON "OrganisationAnalytics"("organisationId");

-- CreateIndex
CREATE UNIQUE INDEX "OrganisationAnalytics_organisationId_period_key" ON "OrganisationAnalytics"("organisationId", "period");

-- CreateIndex
CREATE INDEX "CohortAnalytics_cohortId_idx" ON "CohortAnalytics"("cohortId");

-- CreateIndex
CREATE UNIQUE INDEX "CohortAnalytics_cohortId_period_key" ON "CohortAnalytics"("cohortId", "period");

-- CreateIndex
CREATE INDEX "ParticipantProgress_programmeId_idx" ON "ParticipantProgress"("programmeId");

-- CreateIndex
CREATE INDEX "ParticipantProgress_cohortId_idx" ON "ParticipantProgress"("cohortId");

-- CreateIndex
CREATE UNIQUE INDEX "ParticipantProgress_participantId_programmeId_cohortId_key" ON "ParticipantProgress"("participantId", "programmeId", "cohortId");

-- CreateIndex
CREATE INDEX "CohortResource_cohortId_idx" ON "CohortResource"("cohortId");
ALTER TABLE "Organisation" ADD CONSTRAINT "Organisation_parentOrganisationId_fkey" FOREIGN KEY ("parentOrganisationId") REFERENCES "Organisation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganisationParticipant" ADD CONSTRAINT "OrganisationParticipant_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganisationParticipant" ADD CONSTRAINT "OrganisationParticipant_participantId_fkey" FOREIGN KEY ("participantId") REFERENCES "Participant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Cohort" ADD CONSTRAINT "Cohort_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CohortProgramme" ADD CONSTRAINT "CohortProgramme_cohortId_fkey" FOREIGN KEY ("cohortId") REFERENCES "Cohort"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CohortProgramme" ADD CONSTRAINT "CohortProgramme_programmeId_fkey" FOREIGN KEY ("programmeId") REFERENCES "Programme"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CohortParticipant" ADD CONSTRAINT "CohortParticipant_cohortId_fkey" FOREIGN KEY ("cohortId") REFERENCES "Cohort"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CohortParticipant" ADD CONSTRAINT "CohortParticipant_participantId_fkey" FOREIGN KEY ("participantId") REFERENCES "Participant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CohortEventFlow" ADD CONSTRAINT "CohortEventFlow_cohortId_fkey" FOREIGN KEY ("cohortId") REFERENCES "Cohort"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ParticipantSession" ADD CONSTRAINT "ParticipantSession_participantId_fkey" FOREIGN KEY ("participantId") REFERENCES "Participant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ParticipantMagicLink" ADD CONSTRAINT "ParticipantMagicLink_participantId_fkey" FOREIGN KEY ("participantId") REFERENCES "Participant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProgrammeTimeline" ADD CONSTRAINT "ProgrammeTimeline_programmeId_fkey" FOREIGN KEY ("programmeId") REFERENCES "Programme"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimelineMilestone" ADD CONSTRAINT "TimelineMilestone_timelineId_fkey" FOREIGN KEY ("timelineId") REFERENCES "ProgrammeTimeline"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ParticipantRequest" ADD CONSTRAINT "ParticipantRequest_programmeId_fkey" FOREIGN KEY ("programmeId") REFERENCES "Programme"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ParticipantRequest" ADD CONSTRAINT "ParticipantRequest_cohortId_fkey" FOREIGN KEY ("cohortId") REFERENCES "Cohort"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ParticipantRequest" ADD CONSTRAINT "ParticipantRequest_participantId_fkey" FOREIGN KEY ("participantId") REFERENCES "Participant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ParticipantRequest" ADD CONSTRAINT "ParticipantRequest_formId_fkey" FOREIGN KEY ("formId") REFERENCES "Form"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ParticipantRequestResponse" ADD CONSTRAINT "ParticipantRequestResponse_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "ParticipantRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deliverable" ADD CONSTRAINT "Deliverable_programmeId_fkey" FOREIGN KEY ("programmeId") REFERENCES "Programme"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deliverable" ADD CONSTRAINT "Deliverable_cohortId_fkey" FOREIGN KEY ("cohortId") REFERENCES "Cohort"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deliverable" ADD CONSTRAINT "Deliverable_participantId_fkey" FOREIGN KEY ("participantId") REFERENCES "Participant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CohortCommsChannel" ADD CONSTRAINT "CohortCommsChannel_cohortId_fkey" FOREIGN KEY ("cohortId") REFERENCES "Cohort"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CohortCommsThread" ADD CONSTRAINT "CohortCommsThread_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "CohortCommsChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CohortCommsThread" ADD CONSTRAINT "CohortCommsThread_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "Participant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CohortCommsReply" ADD CONSTRAINT "CohortCommsReply_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "CohortCommsThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CohortCommsReply" ADD CONSTRAINT "CohortCommsReply_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "Participant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CohortCommsReply" ADD CONSTRAINT "CohortCommsReply_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "CohortCommsReply"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProgrammeParticipantCommsChannel" ADD CONSTRAINT "ProgrammeParticipantCommsChannel_programmeId_fkey" FOREIGN KEY ("programmeId") REFERENCES "Programme"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProgrammeParticipantCommsThread" ADD CONSTRAINT "ProgrammeParticipantCommsThread_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "ProgrammeParticipantCommsChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProgrammeParticipantCommsThread" ADD CONSTRAINT "ProgrammeParticipantCommsThread_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "Participant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProgrammeParticipantCommsReply" ADD CONSTRAINT "ProgrammeParticipantCommsReply_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "ProgrammeParticipantCommsThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProgrammeParticipantCommsReply" ADD CONSTRAINT "ProgrammeParticipantCommsReply_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "Participant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProgrammeParticipantCommsReply" ADD CONSTRAINT "ProgrammeParticipantCommsReply_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "ProgrammeParticipantCommsReply"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegistrationPage" ADD CONSTRAINT "RegistrationPage_cohortId_fkey" FOREIGN KEY ("cohortId") REFERENCES "Cohort"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegistrationSubmission" ADD CONSTRAINT "RegistrationSubmission_registrationPageId_fkey" FOREIGN KEY ("registrationPageId") REFERENCES "RegistrationPage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegistrationSubmission" ADD CONSTRAINT "RegistrationSubmission_participantId_fkey" FOREIGN KEY ("participantId") REFERENCES "Participant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnalyticsEvent" ADD CONSTRAINT "AnalyticsEvent_participantId_fkey" FOREIGN KEY ("participantId") REFERENCES "Participant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnalyticsEvent" ADD CONSTRAINT "AnalyticsEvent_cohortId_fkey" FOREIGN KEY ("cohortId") REFERENCES "Cohort"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnalyticsEvent" ADD CONSTRAINT "AnalyticsEvent_programmeId_fkey" FOREIGN KEY ("programmeId") REFERENCES "Programme"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnalyticsEvent" ADD CONSTRAINT "AnalyticsEvent_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganisationAnalytics" ADD CONSTRAINT "OrganisationAnalytics_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CohortAnalytics" ADD CONSTRAINT "CohortAnalytics_cohortId_fkey" FOREIGN KEY ("cohortId") REFERENCES "Cohort"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ParticipantProgress" ADD CONSTRAINT "ParticipantProgress_participantId_fkey" FOREIGN KEY ("participantId") REFERENCES "Participant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ParticipantProgress" ADD CONSTRAINT "ParticipantProgress_programmeId_fkey" FOREIGN KEY ("programmeId") REFERENCES "Programme"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CohortResource" ADD CONSTRAINT "CohortResource_cohortId_fkey" FOREIGN KEY ("cohortId") REFERENCES "Cohort"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CohortResource" ADD CONSTRAINT "CohortResource_addedById_fkey" FOREIGN KEY ("addedById") REFERENCES "Admin"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProgrammeParticipant" ADD CONSTRAINT "ProgrammeParticipant_programmeId_fkey" FOREIGN KEY ("programmeId") REFERENCES "Programme"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProgrammeParticipant" ADD CONSTRAINT "ProgrammeParticipant_participantId_fkey" FOREIGN KEY ("participantId") REFERENCES "Participant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProgrammeParticipant" ADD CONSTRAINT "ProgrammeParticipant_cohortId_fkey" FOREIGN KEY ("cohortId") REFERENCES "Cohort"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProgrammeParticipant" ADD CONSTRAINT "ProgrammeParticipant_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "ParticipantInvoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Programme" ADD CONSTRAINT "Programme_registrationResourceId_fkey" FOREIGN KEY ("registrationResourceId") REFERENCES "ProgrammeResource"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventFlow" ADD CONSTRAINT "EventFlow_programmeId_fkey" FOREIGN KEY ("programmeId") REFERENCES "Programme"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_programmeId_fkey" FOREIGN KEY ("programmeId") REFERENCES "Programme"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_eventFlowId_fkey" FOREIGN KEY ("eventFlowId") REFERENCES "EventFlow"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_cohortEventFlowId_fkey" FOREIGN KEY ("cohortEventFlowId") REFERENCES "CohortEventFlow"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_cohortId_fkey" FOREIGN KEY ("cohortId") REFERENCES "Cohort"("id") ON DELETE SET NULL ON UPDATE CASCADE;
