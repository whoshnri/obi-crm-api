-- Anchor-based opportunity pipeline scheduling.
ALTER TABLE "Opportunity" ADD COLUMN "pipelineAnchorAt" TIMESTAMP(3);
ALTER TABLE "OpportunityEvent" ADD COLUMN "anchorAt" TIMESTAMP(3);
ALTER TABLE "OpportunityEvent" ADD COLUMN "offsetDays" INTEGER;
