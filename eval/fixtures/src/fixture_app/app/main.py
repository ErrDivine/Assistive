"""Command-line entry point."""

import argparse
import logging
import sys

import requests

from app import client, report
from app.config import load_settings_from_env
from app.models import Order, User
from app.storage import save_json


def build_parser():
    """Create the argument parser with one sub-command per task."""
    parser = argparse.ArgumentParser(prog="fixture-app", description="Pull data from the API.")
    parser.add_argument("-v", "--verbose", action="store_true", help="log debug output")
    sub = parser.add_subparsers(dest="command", required=True)
    users = sub.add_parser("users", help="list the users of a team")
    users.add_argument("team")
    orders = sub.add_parser("orders", help="summarise a customer's orders")
    orders.add_argument("customer_id", type=int)
    orders.add_argument("--status", default="open")
    stars = sub.add_parser("stars", help="print a repository's star count")
    stars.add_argument("repo", help="owner/name")
    dump = sub.add_parser("dump", help="save a team's users as JSON")
    dump.add_argument("team")
    dump.add_argument("output")
    return parser


def cmd_users(args, settings, session):
    """Print the users of a team."""
    payloads = client.fetch_users(session, settings.base_url, args.team)
    users = [User.from_payload(p) for p in payloads]
    print(report.describe_users(report.sort_users(users)))
    return 0


def cmd_orders(args, settings, session):
    """Print an order table and revenue per status."""
    payloads = client.fetch_orders(session, settings.base_url, args.customer_id, status=args.status)
    orders = [Order.from_payload(p) for p in payloads]
    print(report.render_order_table(orders))
    for status, cents in sorted(report.revenue_by_status(orders).items()):
        print("%-10s %d" % (status, cents))
    return 0


def cmd_stars(args, settings, session):
    """Print the star count of owner/name."""
    owner, _, name = args.repo.partition("/")
    print(client.fetch_repo_stars(session, owner, name))
    return 0


def cmd_dump(args, settings, session):
    """Fetch a team's users and write them to a JSON file."""
    payloads = client.fetch_users(session, settings.base_url, args.team)
    save_json(args.output, payloads)
    print("wrote %d users to %s" % (len(payloads), args.output))
    return 0


def main(argv=None):
    """Run the CLI and return a process exit code."""
    args = build_parser().parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO, format="%(levelname)s %(message)s")
    settings = load_settings_from_env()
    session = client.make_session(settings.user_agent)
    handlers = {"users": cmd_users, "orders": cmd_orders, "stars": cmd_stars, "dump": cmd_dump}
    try:
        return handlers[args.command](args, settings, session)
    except requests.HTTPError as exc:
        print("request failed: %s" % exc, file=sys.stderr)
        return 1
    finally:
        session.close()


if __name__ == "__main__":
    sys.exit(main())
