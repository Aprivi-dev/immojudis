import { NextResponse } from "next/server";
import {
  environmentalContextCacheControl,
  getEnvironmentalContext,
} from "@/lib/environment.functions";

export async function POST(request: Request) {
  const response = await getEnvironmentalContext(await request.json());
  return NextResponse.json(response, {
    headers: {
      "cache-control": environmentalContextCacheControl(response),
    },
  });
}
