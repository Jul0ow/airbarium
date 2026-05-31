CREATE TYPE "public"."identification_source" AS ENUM('plantnet_auto', 'plantnet_picked', 'none');--> statement-breakpoint
CREATE TYPE "public"."photo_status" AS ENUM('temp', 'promoted', 'expired');--> statement-breakpoint
CREATE TABLE "identifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"photo_url" text NOT NULL,
	"photo_status" "photo_status" DEFAULT 'temp' NOT NULL,
	"plantnet_raw_response" jsonb NOT NULL,
	"top_match_species_id" uuid,
	"top_match_confidence" numeric(5, 4),
	"exif_metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"promoted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "plantnet_usage" (
	"user_id" uuid NOT NULL,
	"day" date NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "plantnet_usage_user_id_day_pk" PRIMARY KEY("user_id","day")
);
--> statement-breakpoint
CREATE TABLE "rate_limit" (
	"key" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "rate_limit_key_window_start_pk" PRIMARY KEY("key","window_start")
);
--> statement-breakpoint
CREATE TABLE "species" (
	"id" uuid PRIMARY KEY NOT NULL,
	"scientific_name" text NOT NULL,
	"common_name" text,
	"family" text,
	"description" text,
	"reference_photo_url" text,
	"wikipedia_url" text,
	"wikipedia_fetched_at" timestamp with time zone,
	"rarity_level" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "species_scientificName_unique" UNIQUE("scientific_name")
);
--> statement-breakpoint
CREATE TABLE "specimens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"identification_id" uuid,
	"species_id" uuid,
	"photo_url" text NOT NULL,
	"identified_name" text,
	"scientific_name" text,
	"family" text,
	"confidence_score" numeric(5, 4),
	"identification_source" "identification_source" DEFAULT 'none' NOT NULL,
	"lat" numeric(9, 6),
	"lng" numeric(9, 6),
	"location_label" text,
	"user_notes" text,
	"collected_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"name" text NOT NULL,
	"avatar_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "identifications" ADD CONSTRAINT "identifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identifications" ADD CONSTRAINT "identifications_top_match_species_id_species_id_fk" FOREIGN KEY ("top_match_species_id") REFERENCES "public"."species"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plantnet_usage" ADD CONSTRAINT "plantnet_usage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "specimens" ADD CONSTRAINT "specimens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "specimens" ADD CONSTRAINT "specimens_identification_id_identifications_id_fk" FOREIGN KEY ("identification_id") REFERENCES "public"."identifications"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "specimens" ADD CONSTRAINT "specimens_species_id_species_id_fk" FOREIGN KEY ("species_id") REFERENCES "public"."species"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "identifications_user_created_idx" ON "identifications" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "identifications_temp_expires_idx" ON "identifications" USING btree ("expires_at") WHERE "identifications"."photo_status" = 'temp';--> statement-breakpoint
CREATE INDEX "rate_limit_expires_idx" ON "rate_limit" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "specimens_user_deleted_collected_idx" ON "specimens" USING btree ("user_id","deleted_at","collected_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "specimens_user_species_active_idx" ON "specimens" USING btree ("user_id","species_id") WHERE "specimens"."deleted_at" IS NULL;