/**
 * Council: Validation Schemas
 * Zod schemas for validating Council configurations
 */

import { z } from 'zod';

// ============================================================================
// Basic Schemas
// ============================================================================

export const stanceSchema = z.enum(['advocate', 'critic', 'neutral', 'wildcard']);

export const interactionStyleSchema = z.enum(['debate', 'build', 'question', 'synthesize', 'review']);

export const councilModeSchema = z.enum([
  'debate',
  'build',
  'review',
  'synthesis',
  'socratic',
  'freeform',
]);

export const turnStrategySchema = z.enum([
  'round-robin',
  'react',
  'popcorn',
  'volunteer',
  'moderator',
  'parallel',
  'relevance',
]);

export const verbositySchema = z.enum(['concise', 'balanced', 'thorough']);

export const speakerTypeSchema = z.enum(['persona', 'user', 'system']);

export const sentimentSchema = z.enum(['agree', 'disagree', 'partial', 'neutral', 'question']);

export const claimTypeSchema = z.enum(['assertion', 'question', 'proposal', 'objection']);

export const councilStatusSchema = z.enum(['active', 'paused', 'resolved']);

export const documentTypeSchema = z.enum(['text', 'pdf', 'image', 'data']);

// ============================================================================
// Predisposition Schema
// ============================================================================

export const predispositionSchema = z.object({
  systemPrompt: z.string().min(10, 'System prompt must be at least 10 characters'),
  stance: stanceSchema,
  arguesFor: z.string().optional(),
  arguesAgainst: z.string().optional(),
  traits: z.array(z.string()).min(1, 'At least one trait required'),
  interactionStyle: interactionStyleSchema,
  domain: z.string().optional(),
});

// ============================================================================
// Persona Schema
// ============================================================================

export const personaSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1, 'Name is required').max(50, 'Name too long'),
  provider: z.string().min(1, 'Provider is required'),
  model: z.string().min(1, 'Model is required'),
  predisposition: predispositionSchema,
  avatar: z.string().optional(),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Invalid hex color'),
  temperature: z.number().min(0).max(1).optional(),
  verbosity: verbositySchema,
  muted: z.boolean().optional(),
});

export const presetPersonaSchema = z.object({
  name: z.string().min(1),
  defaultProvider: z.string().min(1),
  defaultModel: z.string().min(1),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
  avatar: z.string().optional(),
  temperature: z.number().min(0).max(1).optional(),
  verbosity: verbositySchema.optional(),
  predisposition: predispositionSchema,
});

// ============================================================================
// Document & Context Schemas
// ============================================================================

export const documentSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  type: documentTypeSchema,
  content: z.string(),
});

export const sharedContextSchema = z.object({
  description: z.string().min(10, 'Description must be at least 10 characters'),
  documents: z.array(documentSchema).default([]),
  data: z.record(z.string(), z.unknown()).optional(),
  constraints: z.array(z.string()).optional(),
});

// ============================================================================
// Orchestration Schema
// ============================================================================

export const orchestrationConfigSchema = z.object({
  mode: councilModeSchema,
  turnStrategy: turnStrategySchema,
  maxTurnsPerRound: z.number().int().min(1).max(20).default(5),
  maxTotalTurns: z.number().int().min(1).max(100).optional(),
  autoSynthesize: z.boolean().default(true),
  synthesizerId: z.string().optional(),
  convergenceCriteria: z.string().optional(),
  requiresResolution: z.boolean().default(false),
});

// ============================================================================
// Message Schemas
// ============================================================================

export const claimSchema = z.object({
  id: z.string().uuid(),
  text: z.string().min(1),
  type: claimTypeSchema,
  supportedBy: z.array(z.string().uuid()).optional(),
  opposedBy: z.array(z.string().uuid()).optional(),
});

export const councilMessageSchema = z.object({
  id: z.string().uuid(),
  timestamp: z.string().datetime(),
  speakerId: z.string(),
  speakerType: speakerTypeSchema,
  content: z.string().min(1),
  replyingTo: z.string().uuid().optional(),
  threadId: z.string().uuid().optional(),
  sentiment: sentimentSchema.optional(),
  stance: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
  claims: z.array(claimSchema).optional(),
  tokensUsed: z.number().int().min(0),
  latencyMs: z.number().int().min(0),
});

// ============================================================================
// Resolution Schema
// ============================================================================

export const resolutionSchema = z.object({
  summary: z.string().min(10),
  consensusLevel: z.number().min(0).max(1),
  keyDecisions: z.array(z.string()),
  agreements: z.array(z.string()).optional(),
  tensions: z.array(z.string()).optional(),
  dissent: z.array(z.string()).optional(),
  nextSteps: z.array(z.string()).optional(),
  generatedBy: z.string(),
});

// ============================================================================
// Council Schema
// ============================================================================

export const councilSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(100),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  topic: z.string().min(5, 'Topic must be at least 5 characters'),
  sharedContext: sharedContextSchema,
  personas: z.array(personaSchema).min(2, 'At least 2 personas required'),
  orchestration: orchestrationConfigSchema,
  messages: z.array(councilMessageSchema).default([]),
  status: councilStatusSchema,
  resolution: resolutionSchema.optional(),
  totalTokensUsed: z.number().int().min(0).default(0),
  estimatedCost: z.number().min(0).default(0),
});

// ============================================================================
// Request Schemas
// ============================================================================

export const createCouncilRequestSchema = z.object({
  name: z.string().min(1).max(100),
  topic: z.string().min(5),
  sharedContext: sharedContextSchema.partial().optional(),
  personas: z.array(
    z.object({
      templateId: z.string().optional(),
    }).merge(personaSchema.partial())
  ).optional(),
  orchestration: orchestrationConfigSchema.partial().optional(),
});

export const addPersonaRequestSchema = z.object({
  templateId: z.string().optional(),
  persona: personaSchema.partial().optional(),
}).refine(
  (data) => data.templateId || data.persona,
  'Either templateId or persona must be provided'
);

export const sendMessageRequestSchema = z.object({
  content: z.string().min(1),
  replyingTo: z.string().uuid().optional(),
});

export const askPersonaRequestSchema = z.object({
  personaId: z.string().uuid(),
  question: z.string().min(1),
});

export const debateRequestSchema = z.object({
  personaIds: z.tuple([z.string().uuid(), z.string().uuid()]),
  topic: z.string().optional(),
});

export const steelmanRequestSchema = z.object({
  askingPersonaId: z.string().uuid(),
  targetPersonaId: z.string().uuid(),
});

// ============================================================================
// Type Exports
// ============================================================================

export type PredispositionInput = z.infer<typeof predispositionSchema>;
export type PersonaInput = z.infer<typeof personaSchema>;
export type CouncilInput = z.infer<typeof councilSchema>;
export type OrchestrationConfigInput = z.infer<typeof orchestrationConfigSchema>;
export type SharedContextInput = z.infer<typeof sharedContextSchema>;
export type CouncilMessageInput = z.infer<typeof councilMessageSchema>;
export type ResolutionInput = z.infer<typeof resolutionSchema>;

// ============================================================================
// Validation Helpers
// ============================================================================

export function validateCouncil(data: unknown) {
  return councilSchema.safeParse(data);
}

export function validatePersona(data: unknown) {
  return personaSchema.safeParse(data);
}

export function validateCreateCouncilRequest(data: unknown) {
  return createCouncilRequestSchema.safeParse(data);
}

export function validateAddPersonaRequest(data: unknown) {
  return addPersonaRequestSchema.safeParse(data);
}

/**
 * Validate and provide helpful error messages
 */
export function validateWithErrors<T>(
  schema: z.ZodSchema<T>,
  data: unknown
): { success: true; data: T } | { success: false; errors: string[] } {
  const result = schema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }

  const errors = result.error.issues.map((issue) => {
    const path = issue.path.join('.');
    return path ? `${path}: ${issue.message}` : issue.message;
  });

  return { success: false, errors };
}
