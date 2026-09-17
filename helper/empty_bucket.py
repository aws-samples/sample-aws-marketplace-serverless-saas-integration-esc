#!/usr/bin/env python3
"""
Completely empty an S3 bucket, including all object versions and delete markers.

This does NOT delete the bucket itself, only its contents.

Usage:
    python3 empty_bucket.py --profile <aws-profile> --bucket <bucket-name> [--region <region>] [--yes]

Examples:
    python3 empty_bucket.py --profile mp --bucket prod-az5fx5azg63rq-web
    python3 empty_bucket.py --profile mp --bucket my-bucket --region eusc-de-east-1 --yes
"""

import argparse
import sys

import boto3
from botocore.exceptions import ClientError, BotoCoreError

# S3 DeleteObjects accepts at most 1000 keys per request.
DELETE_BATCH_SIZE = 1000


def parse_args():
    parser = argparse.ArgumentParser(
        description="Completely empty an S3 bucket, including all object versions and delete markers."
    )
    parser.add_argument("--profile", required=True, help="AWS named profile to use.")
    parser.add_argument("--bucket", required=True, help="Name of the S3 bucket to empty.")
    parser.add_argument(
        "--region",
        default=None,
        help="AWS region of the bucket (optional; taken from the profile if omitted).",
    )
    parser.add_argument(
        "--yes",
        action="store_true",
        help="Skip the interactive confirmation prompt.",
    )
    return parser.parse_args()


def confirm(bucket, skip_prompt):
    if skip_prompt:
        return True
    print(
        f"WARNING: This will permanently delete ALL objects, versions, and delete "
        f"markers in bucket '{bucket}'. This cannot be undone."
    )
    answer = input(f"Type the bucket name '{bucket}' to confirm: ").strip()
    return answer == bucket


def iter_version_batches(s3_client, bucket):
    """Yield batches of up to DELETE_BATCH_SIZE {Key, VersionId} dicts.

    Covers both object versions and delete markers across all pages.
    """
    paginator = s3_client.get_paginator("list_object_versions")
    batch = []
    for page in paginator.paginate(Bucket=bucket):
        for item in page.get("Versions", []) + page.get("DeleteMarkers", []):
            batch.append({"Key": item["Key"], "VersionId": item["VersionId"]})
            if len(batch) == DELETE_BATCH_SIZE:
                yield batch
                batch = []
    if batch:
        yield batch


def empty_bucket(s3_client, bucket):
    total_deleted = 0
    total_errors = 0

    for batch in iter_version_batches(s3_client, bucket):
        response = s3_client.delete_objects(
            Bucket=bucket,
            Delete={"Objects": batch, "Quiet": True},
        )
        deleted_count = len(batch) - len(response.get("Errors", []))
        total_deleted += deleted_count

        for err in response.get("Errors", []):
            total_errors += 1
            print(
                f"  ERROR deleting {err.get('Key')} (version {err.get('VersionId')}): "
                f"{err.get('Code')} - {err.get('Message')}",
                file=sys.stderr,
            )

        print(f"  Deleted {total_deleted} object versions so far...")

    return total_deleted, total_errors


def main():
    args = parse_args()

    if not confirm(args.bucket, args.yes):
        print("Aborted. No objects were deleted.")
        return 1

    try:
        session = boto3.Session(profile_name=args.profile, region_name=args.region)
        s3_client = session.client("s3")

        # Fail fast if the bucket does not exist or is not accessible.
        s3_client.head_bucket(Bucket=args.bucket)

        print(f"Emptying bucket '{args.bucket}' using profile '{args.profile}'...")
        deleted, errors = empty_bucket(s3_client, args.bucket)

    except (ClientError, BotoCoreError) as exc:
        print(f"AWS error: {exc}", file=sys.stderr)
        return 1

    print(f"\nDone. Deleted {deleted} object versions/delete markers.")
    if errors:
        print(f"Completed with {errors} error(s). See messages above.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
