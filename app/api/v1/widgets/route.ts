import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { checkServiceAuth, unauthorizedResponse } from '@/lib/auth/service';
import { listWidgets } from '@/lib/widgets/registry';

// GET /api/v1/widgets — registry list (id, display_name, description, etc.)
export async function GET(request: NextRequest) {
  if (!checkServiceAuth(request)) return unauthorizedResponse();
  const widgets = listWidgets().map((w) => ({
    id: w.id,
    display_name: w.display_name,
    description: w.description,
    category: w.category,
    default_config: w.default_config,
    config_schema: w.config_schema,
    default_size: w.default_size,
  }));
  return NextResponse.json({ widgets });
}
