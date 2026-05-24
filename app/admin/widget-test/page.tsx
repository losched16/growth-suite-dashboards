import { query } from '@/lib/db';
import { WidgetRenderer } from '@/components/WidgetRenderer';
import { HelloWorldWidget } from '@/lib/widgets/components/HelloWorldWidget';
import type { WidgetInstance } from '@/lib/widgets/types';

export const dynamic = 'force-dynamic';

// Smoke test for the widget framework. Renders HelloWorldWidget against the
// first school in the DB. Remove once real widgets are in place.
export default async function WidgetTest() {
  const { rows } = await query<{ id: string; name: string; ghl_location_id: string }>(
    'SELECT id, name, ghl_location_id FROM schools ORDER BY name LIMIT 1'
  );
  const school = rows[0];
  if (!school) {
    return <div className="p-8 text-gray-600">No schools in DB. Add one in the importer.</div>;
  }

  const instance: WidgetInstance = {
    instance_id: 'test-1',
    widget_id: HelloWorldWidget.id,
    config: HelloWorldWidget.default_config,
    position: { x: 0, y: 0, w: 6, h: 2 },
  };

  return (
    <main className="p-8 max-w-4xl mx-auto">
      <h1 className="text-2xl font-semibold mb-4">Widget framework smoke test</h1>
      <p className="text-sm text-gray-600 mb-4">
        Rendering <code>{HelloWorldWidget.id}</code> against {school.name}.
      </p>
      <WidgetRenderer
        school={{
          schoolId: school.id,
          schoolName: school.name,
          locationId: school.ghl_location_id,
        }}
        instance={instance}
      />
    </main>
  );
}
