import { NextResponse } from "next/server";

const ADMIN_ONLY_RESPONSE = {
  ok: false,
  error: "Cette fonctionnalité est désormais réservée à l’administration.",
  code: "ADMIN_ONLY",
};

export function GET() {
  return retiredResponse();
}

export function POST() {
  return retiredResponse();
}

export function PATCH() {
  return retiredResponse();
}

function retiredResponse() {
  return NextResponse.json(ADMIN_ONLY_RESPONSE, {
    status: 410,
    headers: { "cache-control": "no-store" },
  });
}
