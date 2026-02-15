import Link from 'next/link';
import { Calendar, Layout, ShieldCheck, Zap } from 'lucide-react';

export default function Home() {
  return (
    <div className="min-h-screen bg-white">
      <nav className="border-b">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center">
              <span className="text-white font-bold">T</span>
            </div>
            <span className="text-xl font-bold tracking-tight">TableStack</span>
          </div>
          <div className="flex items-center gap-4">
            <Link href="/dashboard/demo" className="text-sm font-medium text-gray-600 hover:text-gray-900">Demo</Link>
            <button className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-semibold">Get Started</button>
          </div>
        </div>
      </nav>

      <main>
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-20 text-center">
          <h1 className="text-5xl md:text-7xl font-extrabold text-gray-900 mb-6 tracking-tight">
            The Headless <span className="text-blue-600">Reservation</span> Engine.
          </h1>
          <p className="text-xl text-gray-600 mb-10 max-w-2xl mx-auto">
            A multi-tenant API-first platform for restaurant bookings. Built with Next.js, Neon, and Redis for maximum speed and zero cost.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <Link href="/dashboard/demo" className="w-full sm:w-auto bg-gray-900 text-white px-8 py-4 rounded-xl font-bold text-lg hover:bg-gray-800 transition">
              View Owner Dashboard
            </Link>
            <code className="bg-gray-100 p-4 rounded-xl text-sm font-mono border">
              curl -X GET /api/v1/availability
            </code>
          </div>
        </div>

        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-20 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-8">
          <FeatureCard 
            icon={<Zap className="text-yellow-500" />}
            title="Edge Performance"
            description="Built on Vercel Edge Runtime for sub-100ms API responses worldwide."
          />
          <FeatureCard 
            icon={<ShieldCheck className="text-green-500" />}
            title="Anti-Spam Verification"
            description="Automatic email verification keeps your inventory safe from ghost bookings."
          />
          <FeatureCard 
            icon={<Layout className="text-blue-500" />}
            title="Visual Floor Plan"
            description="Draggable editor allows owners to manage their space with zero friction."
          />
          <FeatureCard 
            icon={<Calendar className="text-purple-500" />}
            title="API-First"
            description="Integrate with any frontend, POS, or mobile app using our simple REST API."
          />
        </div>
      </main>
    </div>
  );
}

function FeatureCard({ icon, title, description }: { icon: React.ReactNode, title: string, description: string }) {
  return (
    <div className="p-8 rounded-2xl border border-gray-100 hover:border-blue-100 transition bg-white hover:shadow-xl hover:shadow-blue-500/5 group">
      <div className="w-12 h-12 bg-gray-50 rounded-xl flex items-center justify-center mb-6 group-hover:bg-blue-50 transition">
        {icon}
      </div>
      <h3 className="text-xl font-bold mb-2">{title}</h3>
      <p className="text-gray-600 leading-relaxed">{description}</p>
    </div>
  );
}
