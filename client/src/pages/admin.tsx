import { useEffect, useState, useCallback, useMemo } from 'react';
import { useLocation, Link } from 'wouter';
import { useAuth } from '@/hooks/use-auth';
import { usePageMeta } from '@/hooks/use-page-meta';
import { Footer } from '@/components/footer';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Shield, Users, Tv, BarChart3, Loader2, Edit2, Trash2, RefreshCw, Home, Plus, X, Save, AlertCircle, LogIn, Rocket, Link as LinkIcon, GripVertical, Eye, EyeOff, MessageSquare, Lightbulb, Bug, Search, CheckCircle2 } from 'lucide-react';
import { apiRequest } from '@/lib/queryClient';
import { searchChannelLiveStream } from '@/lib/stream-api';
import { requestTimeoutSignal } from '@/lib/request-timeout';
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy, arrayMove } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { isAdminEmail } from '@shared/admin-access';

interface Channel {
  id: string;
  name: string;
  channelHandle: string | null;
  platform: string;
  iconType: string | null;
  category: string | null;
  videoId: string | null;
  url: string | null;
  logoUrl: string | null;
  isLive: boolean | null;
  isManualOverride: boolean | null;
  isVisible: boolean | null;
  rank: number | null;
  lastUpdated: string | null;
}

function SortableChannelRow({ id, disabled, isHidden, children }: { id: string; disabled?: boolean; isHidden?: boolean; children: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    disabled: disabled || false,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : isHidden ? 0.45 : 1,
    position: 'relative' as const,
    zIndex: isDragging ? 1000000 : undefined,
  };
  return (
    <tr ref={setNodeRef} style={style} className="border-b border-slate-700/50 hover:bg-slate-700/20">
      <td className="py-3 pr-2 w-8">
        <button
          {...attributes}
          {...listeners}
          className="cursor-grab active:cursor-grabbing p-1 text-slate-500 hover:text-slate-300"
          data-testid={`drag-handle-${id}`}
        >
          <GripVertical className="w-4 h-4" />
        </button>
      </td>
      {children}
    </tr>
  );
}

// FIXED: YouTube Video ID extraction with strict 11-character validation
function extractYouTubeVideoId(url: string): string | null {
  if (!url) return null;
  const trimmed = url.trim();

  // Pattern 1: Standard watch URLs
  // Pattern 2: Short youtu.be URLs  
  // Pattern 3: Embed URLs
  // Pattern 4: Live URLs
  // Pattern 5: Shorts URLs
  // Pattern 6: Direct 11-character ID
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/v\/|youtube\.com\/shorts\/|youtube\.com\/live\/)([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/,
  ];

  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    if (match && match[1].length === 11) {
      console.log('[VideoID Extract] Input:', url, '-> Output:', match[1]);
      return match[1];
    }
  }

  console.warn('[VideoID Extract] Failed to extract valid 11-char ID from:', url);
  return null;
}

// UPDATED: Smart handler that accepts any 11-character text for manual entry
function smartVideoIdHandler(rawInput: string): string {
  const trimmed = rawInput.trim();

  // Accept any 11-character alphanumeric string (manual entry mode)
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) {
    console.log('[SmartHandler] Valid 11-char ID:', trimmed);
    return trimmed;
  }

  // Try to extract from URL
  const extracted = extractYouTubeVideoId(trimmed);
  if (extracted) {
    console.log('[SmartHandler] Sanitized:', rawInput, '->', extracted);
    return extracted;
  }

  // Return as-is if can't extract (allows partial manual entry)
  return trimmed;
}

export default function Admin() {
  usePageMeta({
    title: 'Admin Dashboard',
    description: 'OpenBento administrator console for managing users, channels, and feedback.',
  });
  const { user, isLoading, isAuthenticated } = useAuth();
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const [editingChannel, setEditingChannel] = useState<Channel | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [scrapeUrl, setScrapeUrl] = useState('');
  const [isGlobalScraping, setIsGlobalScraping] = useState(false);
  const [scrapeProgress, setScrapeProgress] = useState<{current: number; total: number; currentChannel: string} | null>(null);
  const [isPurging, setIsPurging] = useState(false);
  const [purgeProgress, setPurgeProgress] = useState<{current: number; total: number; currentChannel: string; deleted: number} | null>(null);
  const [newChannel, setNewChannel] = useState({
    id: '',
    name: '',
    channelHandle: '',
    platform: 'youtube',
    iconType: 'news',
    category: 'News',
    videoId: '',
    logoUrl: '',
    isLive: true,
    isManualOverride: false,
    rank: 999
  });
  const [idError, setIdError] = useState('');

  // FIXED: Strict ID sanitization - prevent URLs in ID field
  const sanitizeChannelId = (raw: string): string => {
    // STRICT ID SANITIZATION: Extract name from URL if pasted, ensure slug format
    const urlPatterns = [
      /youtube\.com\/(?:channel\/|c\/|@)([^\/?&#]+)/i,
      /twitch\.tv\/([^\/?&#]+)/i,
      /kick\.com\/([^\/?&#]+)/i,
      /youtu\.be\/([^\/?&#]+)/i,
      /youtube\.com\/watch\?v=([^\/?&#]+)/i, // Extract from watch URLs too
    ];

    // Check if input contains URL markers (http://, .com, .tv, etc.)
    const hasUrlMarkers = /^https?:\/\//i.test(raw) || /\.(com|tv|be|io)\//i.test(raw);

    if (hasUrlMarkers) {
      // Extract meaningful name from URL
      for (const pattern of urlPatterns) {
        const match = raw.match(pattern);
        if (match) {
          const extracted = match[1].toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
          console.log('[ID Sanitize] Extracted from URL:', raw, '->', extracted);
          return extracted;
        }
      }
      // Fallback: extract domain or path as slug
      const cleanUrl = raw.replace(/^https?:\/\//, '').replace(/\/$/, '');
      const slug = cleanUrl.split('/')[cleanUrl.split('/').length - 1] || 'channel';
      return slug.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    }

    // Not a URL - sanitize as slug (lowercase, alphanumeric + dashes only)
    return raw.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  };

  const isValidChannelId = (id: string): boolean => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(id);

  const handleGlobalScrape = async () => {
    if (!channels.length) return;

    setIsGlobalScraping(true);
    // SYNC ALL STREAMS: Only scrape channels that are NOT marked as manual override
    const youtubeChannels = channels.filter(c => 
      c.platform === 'youtube' && 
      c.channelHandle && 
      !c.isManualOverride // Skip manual override channels
    );

    console.log(`[SYNC ALL] Starting scrape for ${youtubeChannels.length} non-override channels`);

    for (let i = 0; i < youtubeChannels.length; i++) {
      const channel = youtubeChannels[i];
      setScrapeProgress({ current: i + 1, total: youtubeChannels.length, currentChannel: channel.name });

      try {
        if (channel.channelHandle) {
          const result = await searchChannelLiveStream(channel.channelHandle, true);
          if (result.liveVideoId) {
            // FIXED: Sanitize videoId before sending to API
            const cleanVideoId = smartVideoIdHandler(result.liveVideoId);
            await apiRequest('PATCH', `/api/admin/channels/${channel.id}`, { 
              videoId: cleanVideoId,
              isLive: true 
            });
          }
        }
      } catch (err) {
        console.error(`[SYNC ALL] Failed for ${channel.name}:`, err);
      }

      await new Promise(r => setTimeout(r, 500));
    }

    setIsGlobalScraping(false);
    setScrapeProgress(null);
    queryClient.invalidateQueries({ queryKey: ['/api/admin/channels'] });
    queryClient.invalidateQueries({ queryKey: ['/api/links'] });
  };

  const handleScrapeUrl = () => {
    if (!scrapeUrl || !editingChannel) return;
    // FIXED: Always sanitize extracted video ID
    const extractedId = extractYouTubeVideoId(scrapeUrl);
    if (extractedId) {
      setEditingChannel({ ...editingChannel, videoId: extractedId, isManualOverride: true });
      setScrapeUrl('');
    }
  };

  const handlePurgeBrokenStreams = async () => {
    if (!channels.length) return;

    setIsPurging(true);
    let deletedCount = 0;

    const youtubeChannels = channels.filter(c => 
      c.platform === 'youtube' && 
      c.videoId && 
      !c.isManualOverride
    );

    console.log(`[PURGE] Starting purge check for ${youtubeChannels.length} YouTube channels`);

    for (let i = 0; i < youtubeChannels.length; i++) {
      const channel = youtubeChannels[i];
      setPurgeProgress({ 
        current: i + 1, 
        total: youtubeChannels.length, 
        currentChannel: channel.name,
        deleted: deletedCount 
      });

      try {
        const response = await fetch(`/api/youtube/validate-video/${channel.videoId}`, {
          signal: requestTimeoutSignal(),
        });
        const result = await response.json();

        if (!result.valid) {
          console.log(`[PURGE] Broken stream detected: ${channel.name} - ${result.reason}`);

          if (channel.channelHandle) {
            const searchResponse = await fetch(`/api/youtube/search-live/${encodeURIComponent(channel.channelHandle)}`, {
              signal: requestTimeoutSignal(),
            });
            const searchResult = await searchResponse.json();

            if (searchResult.latestVideoId) {
              const fallbackResponse = await fetch(`/api/youtube/validate-video/${searchResult.latestVideoId}`, {
                signal: requestTimeoutSignal(),
              });
              const fallbackResult = await fallbackResponse.json();

              if (!fallbackResult.valid) {
                console.log(`[PURGE] Fallback also broken for ${channel.name}, soft deleting...`);
                // FIXED: Soft delete instead of hard delete
                await apiRequest('PATCH', `/api/admin/channels/${channel.id}`, { isVisible: false });
                deletedCount++;
              } else {
                console.log(`[PURGE] Fallback works for ${channel.name}, updating videoId`);
                // FIXED: Sanitize videoId before update
                const cleanVideoId = smartVideoIdHandler(searchResult.latestVideoId);
                await apiRequest('PATCH', `/api/admin/channels/${channel.id}`, { 
                  videoId: cleanVideoId,
                  isLive: false 
                });
              }
            } else {
              console.log(`[PURGE] No fallback available for ${channel.name}, soft deleting...`);
              // FIXED: Soft delete instead of hard delete
              await apiRequest('PATCH', `/api/admin/channels/${channel.id}`, { isVisible: false });
              deletedCount++;
            }
          } else {
            console.log(`[PURGE] No channel handle for ${channel.name}, soft deleting broken channel...`);
            // FIXED: Soft delete instead of hard delete
            await apiRequest('PATCH', `/api/admin/channels/${channel.id}`, { isVisible: false });
            deletedCount++;
          }
        }
      } catch (err) {
        console.error(`[PURGE] Failed to check ${channel.name}:`, err);
      }

      await new Promise(r => setTimeout(r, 300));
    }

    setIsPurging(false);
    setPurgeProgress(null);
    queryClient.invalidateQueries({ queryKey: ['/api/admin/channels'] });
    queryClient.invalidateQueries({ queryKey: ['/api/links'] });

    alert(`Purge complete! Soft-deleted ${deletedCount} broken channels (they can be restored).`);
  };

  const isAdmin = isAuthenticated && isAdminEmail(user?.email);

  useEffect(() => {
    if (!isLoading && isAuthenticated && !isAdmin) {
      setLocation('/');
    }
  }, [isLoading, isAuthenticated, isAdmin, setLocation]);

  const { data: channelsData, isLoading: channelsLoading, error: channelsError } = useQuery<{ channels: Channel[] }>({
    queryKey: ['/api/admin/channels'],
    enabled: isAdmin,
  });

  interface AdminUser {
    id: string;
    email: string;
    createdAt: string;
    lastSignIn: string | null;
    emailConfirmed: boolean;
    provider: string;
  }

  const { data: usersData, isLoading: usersLoading } = useQuery<{ users: AdminUser[], total: number }>({
    queryKey: ['/api/admin/users'],
    enabled: isAdmin,
  });

  interface FeedbackItem {
    id: string;
    userEmail: string | null;
    message: string;
    type: string;
    screenshot: string | null;
    createdAt: string;
  }

  const { data: feedbackData, isLoading: feedbackLoading } = useQuery<{ feedback: FeedbackItem[] }>({
    queryKey: ['/api/admin/feedback'],
    enabled: isAdmin,
  });

  const [userSearchQuery, setUserSearchQuery] = useState('');
  const [feedbackFilterType, setFeedbackFilterType] = useState<'all' | 'bug' | 'idea'>('all');
  const [resolvedFeedbackIds, setResolvedFeedbackIds] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem('openBentoResolvedFeedback');
      return saved ? new Set(JSON.parse(saved)) : new Set();
    } catch { return new Set(); }
  });
  const [hideResolved, setHideResolved] = useState(false);

  const toggleFeedbackResolved = useCallback((id: string) => {
    setResolvedFeedbackIds(prev => {
      const next = new Set(Array.from(prev));
      if (next.has(id)) next.delete(id); else next.add(id);
      localStorage.setItem('openBentoResolvedFeedback', JSON.stringify(Array.from(next)));
      return next;
    });
  }, []);

  const filteredUsers = useMemo(() => {
    if (!usersData?.users) return [];
    return usersData.users.filter(u => {
      if (userSearchQuery && !u.email?.toLowerCase().includes(userSearchQuery.toLowerCase())) return false;
      return true;
    });
  }, [usersData?.users, userSearchQuery]);

  const filteredFeedback = useMemo(() => {
    if (!feedbackData?.feedback) return [];
    return feedbackData.feedback.filter(item => {
      if (feedbackFilterType !== 'all' && item.type !== feedbackFilterType) return false;
      if (hideResolved && resolvedFeedbackIds.has(item.id)) return false;
      return true;
    });
  }, [feedbackData?.feedback, feedbackFilterType, hideResolved, resolvedFeedbackIds]);

  const migrateMutation = useMutation({
    mutationFn: () => apiRequest('POST', '/api/admin/migrate-channels'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/admin/channels'] });
    },
  });

  const hideMutation = useMutation({
    mutationFn: ({ id, isVisible }: { id: string; isVisible: boolean }) =>
      apiRequest('PATCH', `/api/admin/channels/${id}`, { isVisible }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/admin/channels'] });
      queryClient.invalidateQueries({ queryKey: ['/api/links'] });
      queryClient.refetchQueries({ queryKey: ['/api/admin/channels'] });
      queryClient.refetchQueries({ queryKey: ['/api/links'] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: ({ id }: { id: string }) =>
      apiRequest('DELETE', `/api/admin/channels/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/admin/channels'] });
      queryClient.invalidateQueries({ queryKey: ['/api/links'] });
      queryClient.refetchQueries({ queryKey: ['/api/admin/channels'] });
      queryClient.refetchQueries({ queryKey: ['/api/links'] });
    },
  });

  const handleReveal = (id: string) => {
    console.log("Revealing channel ID:", id);
    hideMutation.mutate({ id, isVisible: true });
  };

  const handleHide = (id: string) => {
    console.log("Hiding channel ID:", id);
    hideMutation.mutate({ id, isVisible: false });
  };

  const handlePermanentDelete = (id: string, name: string) => {
    if (confirm(`PERMANENTLY delete "${name}"? This cannot be undone.`)) {
      console.log("Permanently deleting channel ID:", id);
      deleteMutation.mutate({ id });
    }
  };

  const [showHidden, setShowHidden] = useState(false);

  const updateMutation = useMutation({
    mutationFn: (channel: Partial<Channel> & { id: string }) => {
      // FIXED: Sanitize videoId before sending to API
      const sanitizedChannel = {
        ...channel,
        videoId: channel.videoId ? smartVideoIdHandler(channel.videoId) : channel.videoId
      };
      console.log('[Update] Sanitizing channel data:', channel, '->', sanitizedChannel);
      return apiRequest('PATCH', `/api/admin/channels/${channel.id}`, sanitizedChannel);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/admin/channels'] });
      queryClient.invalidateQueries({ queryKey: ['/api/links'] });
      queryClient.refetchQueries({ queryKey: ['/api/links'] });
      setEditingChannel(null);
    },
  });

  const createMutation = useMutation({
    mutationFn: (channel: typeof newChannel) => {
      // FIXED: Sanitize both ID and videoId before creating
      const sanitizedChannel = {
        ...channel,
        id: sanitizeChannelId(channel.id),
        videoId: channel.videoId ? smartVideoIdHandler(channel.videoId) : ''
      };
      console.log('[Create] Sanitizing new channel:', channel, '->', sanitizedChannel);
      return apiRequest('POST', '/api/admin/channels', sanitizedChannel);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/admin/channels'] });
      queryClient.invalidateQueries({ queryKey: ['/api/links'] });
      queryClient.refetchQueries({ queryKey: ['/api/links'] });
      setShowAddForm(false);
      setNewChannel({
        id: '',
        name: '',
        channelHandle: '',
        platform: 'youtube',
        iconType: 'news',
        category: 'News',
        videoId: '',
        logoUrl: '',
        isLive: true,
        isManualOverride: false,
        rank: 999
      });
      setIdError('');
    },
  });

  const channels = channelsData?.channels || [];

  const filteredChannels = useMemo(() => {
    if (showHidden) return channels;
    return channels.filter(ch => ch.isVisible !== false);
  }, [channels, showHidden]);

  const sortedChannels = useMemo(() => [...filteredChannels].sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999)), [filteredChannels]);

  const hiddenCount = useMemo(() => channels.filter(ch => ch.isVisible === false).length, [channels]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  const handleDragEnd = useCallback(async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = sortedChannels.findIndex(c => c.id === active.id);
    const newIndex = sortedChannels.findIndex(c => c.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    const reordered = arrayMove(sortedChannels, oldIndex, newIndex);
    const updates = reordered.map((ch, idx) => ({ id: ch.id, rank: idx + 1 }));

    try {
      await apiRequest('POST', '/api/admin/channels/reorder', { updates });
      queryClient.invalidateQueries({ queryKey: ['/api/admin/channels'] });
      queryClient.invalidateQueries({ queryKey: ['/api/links'] });
    } catch (err) {
      console.error('[Admin] Reorder failed:', err);
    }
  }, [sortedChannels, queryClient]);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-slate-900 flex flex-col">
        <div className="flex-1 flex items-center justify-center">
          <Loader2 className="w-12 h-12 text-cyan-400 animate-spin" />
        </div>
        <Footer />
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-slate-900 flex flex-col">
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <Shield className="w-16 h-16 text-cyan-500 mx-auto mb-4" />
            <h1 className="text-2xl font-bold text-white mb-2">Admin Login Required</h1>
            <p className="text-slate-400 mb-6">Please log in with your admin account to access this page.</p>
            <button
              onClick={() => setLocation('/')}
              className="flex items-center gap-2 px-6 py-3 bg-cyan-600 hover:bg-cyan-500 rounded-lg text-white font-medium transition-colors mx-auto"
              data-testid="button-admin-login"
            >
              <LogIn className="w-5 h-5" />
              Go to Dashboard to Log In
            </button>
            <Link href="/" className="text-slate-400 hover:text-slate-300 text-sm mt-4 inline-block">
              Back to Dashboard
            </Link>
          </div>
        </div>
        <Footer />
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="min-h-screen bg-slate-900 flex flex-col">
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <Shield className="w-16 h-16 text-red-500 mx-auto mb-4" />
            <h1 className="text-2xl font-bold text-white mb-2">Access Denied</h1>
            <p className="text-slate-400">You don't have admin privileges.</p>
            <Link href="/" className="text-cyan-400 hover:text-cyan-300 text-sm mt-4 inline-block">
              Back to Dashboard
            </Link>
          </div>
        </div>
        <Footer />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-900 flex flex-col">
      <div className="flex-1 p-8">
      <div className="max-w-7xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-4">
            <Shield className="w-10 h-10 text-cyan-400" />
            <h1 className="text-4xl font-bold text-white" data-testid="text-admin-title">
              Admin Dashboard
            </h1>
          </div>
          <Link href="/">
            <a className="flex items-center gap-2 px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded-lg text-white transition-colors">
              <Home className="w-5 h-5" />
              Back to Dashboard
            </a>
          </Link>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div 
            className="bg-slate-800/50 backdrop-blur-sm border border-slate-700 rounded-xl p-6"
            data-testid="card-user-list"
          >
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 bg-blue-500/20 rounded-lg">
                <Users className="w-6 h-6 text-blue-400" />
              </div>
              <h2 className="text-xl font-semibold text-white">
                User List {usersData?.total ? `(${usersData.total})` : ''}
              </h2>
            </div>
            <div className="flex flex-wrap items-center gap-2 mb-3">
              <div className="relative flex-1 min-w-[180px]">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                <input
                  type="text"
                  placeholder="Search by email..."
                  value={userSearchQuery}
                  onChange={(e) => setUserSearchQuery(e.target.value)}
                  className="w-full pl-9 pr-3 py-2 bg-slate-900/60 border border-slate-700 rounded-lg text-sm text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500"
                  data-testid="input-user-search"
                />
              </div>
              {userSearchQuery && (
                <span className="text-xs text-slate-500">{filteredUsers.length} result{filteredUsers.length !== 1 ? 's' : ''}</span>
              )}
            </div>
            <div className="bg-slate-900/50 rounded-lg p-4 max-h-[400px] overflow-y-auto">
              {usersLoading ? (
                <div className="flex items-center justify-center py-4">
                  <Loader2 className="w-6 h-6 text-cyan-400 animate-spin" />
                </div>
              ) : filteredUsers.length > 0 ? (
                <div className="space-y-2">
                  {filteredUsers.map((u) => (
                    <div key={u.id} className="flex items-center gap-3 p-3 bg-slate-800 rounded-lg">
                      <div className={`w-10 h-10 rounded-full flex items-center justify-center ${
                        isAdminEmail(u.email) ? 'bg-cyan-500/20' : 'bg-slate-700'
                      }`}>
                        <Users className={`w-5 h-5 ${isAdminEmail(u.email) ? 'text-cyan-400' : 'text-slate-400'}`} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-white font-medium truncate">{u.email}</p>
                        <div className="flex items-center gap-2 text-slate-400 text-sm">
                          <span className={`px-2 py-0.5 rounded text-xs ${
                            u.provider === 'google' ? 'bg-red-500/20 text-red-400' : 'bg-blue-500/20 text-blue-400'
                          }`}>
                            {u.provider}
                          </span>
                          {isAdminEmail(u.email) && (
                            <span className="px-2 py-0.5 rounded text-xs bg-cyan-500/20 text-cyan-400">Admin</span>
                          )}
                          {u.emailConfirmed && (
                            <span className="text-emerald-400 text-xs">Verified</span>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="text-right text-xs text-slate-500">
                          {u.lastSignIn && (
                            <p>Last: {new Date(u.lastSignIn).toLocaleDateString()}</p>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <>
                  <div className="flex items-center gap-3 p-3 bg-slate-800 rounded-lg">
                    <div className="w-10 h-10 bg-cyan-500/20 rounded-full flex items-center justify-center">
                      <Users className="w-5 h-5 text-cyan-400" />
                    </div>
                    <div>
                      <p className="text-white font-medium">{user?.email}</p>
                      <p className="text-slate-400 text-sm">Admin (You)</p>
                    </div>
                  </div>
                  <p className="text-slate-500 text-sm mt-4 text-center">
                    No additional users found
                  </p>
                </>
              )}
            </div>
          </div>

          <div 
            className="bg-slate-800/50 backdrop-blur-sm border border-slate-700 rounded-xl p-6"
            data-testid="card-system-stats"
          >
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 bg-emerald-500/20 rounded-lg">
                <BarChart3 className="w-6 h-6 text-emerald-400" />
              </div>
              <h2 className="text-xl font-semibold text-white">System Stats</h2>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="bg-slate-900/50 rounded-lg p-4 text-center">
                <p className="text-3xl font-bold text-cyan-400">{channels.length}</p>
                <p className="text-slate-400 text-sm">Total Channels</p>
              </div>
              <div className="bg-slate-900/50 rounded-lg p-4 text-center">
                <p className="text-3xl font-bold text-emerald-400">
                  {channels.filter(c => c.isLive).length}
                </p>
                <p className="text-slate-400 text-sm">Live Channels</p>
              </div>
              <div className="bg-slate-900/50 rounded-lg p-4 text-center">
                <p className="text-3xl font-bold text-purple-400">
                  {channels.filter(c => c.platform === 'youtube').length}
                </p>
                <p className="text-slate-400 text-sm">YouTube</p>
              </div>
              <div className="bg-slate-900/50 rounded-lg p-4 text-center">
                <p className="text-3xl font-bold text-orange-400">
                  {channels.filter(c => c.platform !== 'youtube').length}
                </p>
                <p className="text-slate-400 text-sm">Other Platforms</p>
              </div>
            </div>
          </div>
        </div>

        <div
          className="mt-6 bg-slate-800/50 backdrop-blur-sm border border-slate-700 rounded-xl p-6"
          data-testid="card-feedback"
        >
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 bg-amber-500/20 rounded-lg">
              <MessageSquare className="w-6 h-6 text-amber-400" />
            </div>
            <h2 className="text-xl font-semibold text-white">
              Feedback {feedbackData?.feedback?.length ? `(${feedbackData.feedback.length})` : ''}
            </h2>
          </div>
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <div className="flex rounded-lg overflow-hidden border border-slate-700">
              {(['all', 'bug', 'idea'] as const).map((ft) => (
                <button
                  key={ft}
                  onClick={() => setFeedbackFilterType(ft)}
                  className={`px-3 py-2 text-xs font-medium transition-colors flex items-center gap-1.5 ${
                    feedbackFilterType === ft
                      ? 'bg-cyan-600 text-white'
                      : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
                  }`}
                  data-testid={`button-feedback-filter-${ft}`}
                >
                  {ft === 'bug' && <Bug className="w-3 h-3" />}
                  {ft === 'idea' && <Lightbulb className="w-3 h-3" />}
                  {ft === 'all' ? 'All' : ft === 'bug' ? 'Bugs' : 'Ideas'}
                </button>
              ))}
            </div>
            <button
              onClick={() => setHideResolved(!hideResolved)}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium border transition-colors ${
                hideResolved
                  ? 'bg-emerald-600/20 border-emerald-600 text-emerald-400'
                  : 'bg-slate-800 border-slate-700 text-slate-400 hover:bg-slate-700'
              }`}
              data-testid="button-hide-resolved"
            >
              <CheckCircle2 className="w-3 h-3" />
              {hideResolved ? 'Hiding Resolved' : 'Hide Resolved'}
            </button>
            <span className="text-xs text-slate-500 ml-auto">
              {filteredFeedback.length} item{filteredFeedback.length !== 1 ? 's' : ''}
            </span>
          </div>
          <div className="bg-slate-900/50 rounded-lg p-4 max-h-[400px] overflow-y-auto">
            {feedbackLoading ? (
              <div className="flex items-center justify-center py-4">
                <Loader2 className="w-6 h-6 text-cyan-400 animate-spin" />
              </div>
            ) : filteredFeedback.length > 0 ? (
              <div className="space-y-3">
                {filteredFeedback.map((item) => (
                  <div key={item.id} className={`p-3 bg-slate-800 rounded-lg border-l-4 border-l-transparent ${resolvedFeedbackIds.has(item.id) ? 'opacity-50' : ''}`} style={{
                    borderLeftColor: item.type === 'bug' ? '#ef4444' : '#3b82f6'
                  }}>
                    <div className="flex items-center gap-2 mb-2">
                      {item.type === 'bug' ? (
                        <Bug className="w-4 h-4 text-red-400" />
                      ) : (
                        <Lightbulb className="w-4 h-4 text-blue-400" />
                      )}
                      <span className={`px-2 py-0.5 rounded text-xs uppercase font-bold ${
                        item.type === 'bug' ? 'bg-red-500/20 text-red-400' : 'bg-blue-500/20 text-blue-400'
                      }`}>
                        {item.type}
                      </span>
                      <span className="text-slate-500 text-xs ml-auto">
                        {item.createdAt ? new Date(item.createdAt).toLocaleString() : ''}
                      </span>
                      <button
                        onClick={() => toggleFeedbackResolved(item.id)}
                        className={`p-1 rounded transition-colors ${
                          resolvedFeedbackIds.has(item.id)
                            ? 'text-emerald-400 hover:text-emerald-300'
                            : 'text-slate-600 hover:text-slate-400'
                        }`}
                        title={resolvedFeedbackIds.has(item.id) ? 'Mark as unresolved' : 'Mark as resolved'}
                        data-testid={`button-resolve-feedback-${item.id}`}
                      >
                        <CheckCircle2 className="w-4 h-4" />
                      </button>
                    </div>
                    <p className="text-white text-sm">{item.message}</p>
                    {item.screenshot && (
                      <div className="mt-2">
                        <img
                          src={item.screenshot}
                          alt="Feedback screenshot"
                          className="max-h-40 rounded-md border border-slate-700 cursor-pointer hover:opacity-80 transition-opacity"
                          onClick={() => window.open(item.screenshot!, '_blank', 'noopener,noreferrer')}
                          title="Click to view full size"
                          data-testid={`img-feedback-screenshot-${item.id}`}
                        />
                      </div>
                    )}
                    {item.userEmail && (
                      <p className="text-slate-500 text-xs mt-1">From: {item.userEmail}</p>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-slate-500 text-sm text-center py-4">
                {feedbackData?.feedback?.length ? 'No feedback matches your filters.' : 'No feedback received yet.'}
              </p>
            )}
          </div>
        </div>

        <div 
          className="mt-6 bg-slate-800/50 backdrop-blur-sm border border-slate-700 rounded-xl p-6"
          data-testid="card-channel-manager"
        >
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-purple-500/20 rounded-lg">
                <Tv className="w-6 h-6 text-purple-400" />
              </div>
              <h2 className="text-xl font-semibold text-white">Channel Manager</h2>
            </div>
            <div className="flex gap-2 flex-wrap">
              <button
                onClick={handleGlobalScrape}
                disabled={isGlobalScraping}
                className="flex items-center gap-2 px-3 py-2 bg-orange-600 hover:bg-orange-500 rounded-lg text-white text-sm transition-colors disabled:opacity-50"
                data-testid="button-global-scrape"
              >
                {isGlobalScraping ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    {scrapeProgress ? `${scrapeProgress.current}/${scrapeProgress.total}` : 'Scraping...'}
                  </>
                ) : (
                  <>
                    <Rocket className="w-5 h-5" />
                    SYNC ALL STREAMS
                  </>
                )}
              </button>
              <button
                onClick={() => setShowAddForm(true)}
                className="flex items-center gap-2 px-3 py-2 bg-emerald-600 hover:bg-emerald-500 rounded-lg text-white text-sm transition-colors"
                data-testid="button-add-channel"
              >
                <Plus className="w-4 h-4" />
                Add Channel
              </button>
              <button
                onClick={() => setShowHidden(!showHidden)}
                className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${
                  showHidden
                    ? 'bg-amber-600 hover:bg-amber-500 text-white'
                    : 'bg-slate-700 hover:bg-slate-600 text-slate-300'
                }`}
                data-testid="button-toggle-hidden"
              >
                {showHidden ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                {showHidden ? `Hide ${hiddenCount} Hidden` : `Show ${hiddenCount} Hidden`}
              </button>
              <button
                onClick={() => migrateMutation.mutate()}
                disabled={migrateMutation.isPending}
                className="flex items-center gap-2 px-3 py-2 bg-cyan-600 hover:bg-cyan-500 rounded-lg text-white text-sm transition-colors disabled:opacity-50"
                data-testid="button-migrate-channels"
              >
                <RefreshCw className={`w-4 h-4 ${migrateMutation.isPending ? 'animate-spin' : ''}`} />
                Import from JSON
              </button>
              <button
                onClick={handlePurgeBrokenStreams}
                disabled={isPurging || isGlobalScraping}
                className="flex items-center gap-2 px-3 py-2 bg-red-600 hover:bg-red-500 rounded-lg text-white text-sm transition-colors disabled:opacity-50"
                data-testid="button-purge-broken"
              >
                {isPurging ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    {purgeProgress ? `${purgeProgress.current}/${purgeProgress.total} (${purgeProgress.deleted} deleted)` : 'Purging...'}
                  </>
                ) : (
                  <>
                    <Trash2 className="w-5 h-5" />
                    🧹 Purge Broken Streams
                  </>
                )}
              </button>
            </div>
            {scrapeProgress && (
              <div className="mt-2 text-sm text-slate-400">
                Currently scraping: <span className="text-cyan-400">{scrapeProgress.currentChannel}</span>
              </div>
            )}
            {purgeProgress && (
              <div className="mt-2 text-sm text-slate-400">
                Checking: <span className="text-red-400">{purgeProgress.currentChannel}</span> | Deleted: <span className="text-red-400">{purgeProgress.deleted}</span>
              </div>
            )}
          </div>

          {showAddForm && (
            <div className="mb-4 p-4 bg-slate-900/50 rounded-lg border border-slate-600">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-white font-medium">Add New Channel</h3>
                <button onClick={() => { setShowAddForm(false); setIdError(''); }} className="text-slate-400 hover:text-white">
                  <X className="w-5 h-5" />
                </button>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div className="flex flex-col gap-1">
                  <input
                    type="text"
                    placeholder="ID (e.g., sky-news)"
                    value={newChannel.id}
                    onChange={(e) => {
                      const raw = e.target.value;
                      // FIXED: Always sanitize ID input
                      const sanitized = sanitizeChannelId(raw);
                      setNewChannel({ ...newChannel, id: sanitized });

                      // Show helpful error messages
                      if (raw !== sanitized) {
                        setIdError(`Auto-sanitized: "${raw}" → "${sanitized}"`);
                      } else if (sanitized && !isValidChannelId(sanitized)) {
                        setIdError('Only lowercase letters, numbers, and dashes allowed');
                      } else {
                        setIdError('');
                      }
                    }}
                    className={`px-3 py-2 bg-slate-800 border rounded-lg text-white text-sm ${idError ? 'border-amber-500' : 'border-slate-600'}`}
                    data-testid="input-new-channel-id"
                  />
                  {idError && <span className="text-amber-400 text-xs">{idError}</span>}
                </div>
                <input
                  type="text"
                  placeholder="Name"
                  value={newChannel.name}
                  onChange={(e) => setNewChannel({ ...newChannel, name: e.target.value })}
                  className="px-3 py-2 bg-slate-800 border border-slate-600 rounded-lg text-white text-sm"
                />
                <input
                  type="text"
                  placeholder="Channel Handle"
                  value={newChannel.channelHandle}
                  onChange={(e) => setNewChannel({ ...newChannel, channelHandle: e.target.value })}
                  className="px-3 py-2 bg-slate-800 border border-slate-600 rounded-lg text-white text-sm"
                />
                <input
                  type="text"
                  placeholder="Video ID or YouTube URL"
                  value={newChannel.videoId}
                  onChange={(e) => {
                    // FIXED: Always sanitize video ID input
                    const resolved = smartVideoIdHandler(e.target.value);
                    setNewChannel({ ...newChannel, videoId: resolved });
                  }}
                  className="px-3 py-2 bg-slate-800 border border-slate-600 rounded-lg text-white text-sm"
                  data-testid="input-new-channel-videoid"
                />
                <input
                  type="text"
                  placeholder="Channel Logo URL"
                  value={newChannel.logoUrl}
                  onChange={(e) => setNewChannel({ ...newChannel, logoUrl: e.target.value })}
                  className="px-3 py-2 bg-slate-800 border border-slate-600 rounded-lg text-white text-sm"
                  data-testid="input-new-channel-logo"
                />
                <select
                  value={newChannel.platform}
                  onChange={(e) => setNewChannel({ ...newChannel, platform: e.target.value })}
                  className="px-3 py-2 bg-slate-800 border border-slate-600 rounded-lg text-white text-sm"
                >
                  <option value="youtube">YouTube</option>
                  <option value="twitch">Twitch</option>
                  <option value="kick">Kick</option>
                </select>
                <select
                  value={newChannel.category}
                  onChange={(e) => setNewChannel({ ...newChannel, category: e.target.value })}
                  className="px-3 py-2 bg-slate-800 border border-slate-600 rounded-lg text-white text-sm"
                >
                  <option value="News">News</option>
                  <option value="Science">Science</option>
                  <option value="Gaming">Gaming</option>
                  <option value="Finance">Finance</option>
                  <option value="Music">Music</option>
                </select>
                <input
                  type="number"
                  placeholder="Rank (1=top)"
                  value={newChannel.rank}
                  onChange={(e) => setNewChannel({ ...newChannel, rank: parseInt(e.target.value) || 999 })}
                  className="px-3 py-2 bg-slate-800 border border-slate-600 rounded-lg text-white text-sm w-24"
                  min="1"
                  data-testid="input-new-channel-rank"
                />
                <label className="flex items-center gap-2 text-sm text-slate-300 px-1">
                  <input
                    type="checkbox"
                    checked={newChannel.isManualOverride}
                    onChange={(e) => setNewChannel({ ...newChannel, isManualOverride: e.target.checked })}
                    className="w-4 h-4"
                    data-testid="checkbox-new-channel-manual-override"
                  />
                  Manual Override (locked)
                </label>
                <button
                  onClick={() => createMutation.mutate(newChannel)}
                  disabled={createMutation.isPending || !newChannel.id || !newChannel.name}
                  className="flex items-center justify-center gap-2 px-3 py-2 bg-emerald-600 hover:bg-emerald-500 rounded-lg text-white text-sm transition-colors disabled:opacity-50 col-span-2"
                  data-testid="button-create-channel"
                >
                  <Save className="w-4 h-4" />
                  {createMutation.isPending ? 'Creating...' : 'Create Channel'}
                </button>
              </div>
            </div>
          )}

          {channelsLoading ? (
            <div className="flex items-center justify-center h-32">
              <Loader2 className="w-8 h-8 text-cyan-400 animate-spin" />
            </div>
          ) : channelsError ? (
            <div className="flex items-center justify-center h-32 text-red-400">
              <AlertCircle className="w-6 h-6 mr-2" />
              Error loading channels
            </div>
          ) : channels.length === 0 ? (
            <div className="text-center py-8 text-slate-500">
              <Tv className="w-12 h-12 mx-auto mb-3 opacity-50" />
              <p>No channels in database. Click "Import from JSON" to migrate existing channels.</p>
            </div>
          ) : (
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-slate-400 border-b border-slate-700">
                      <th className="pb-3 pr-2 w-8"></th>
                      <th className="pb-3 pr-4">Name</th>
                      <th className="pb-3 pr-4">Platform</th>
                      <th className="pb-3 pr-4">Category</th>
                      <th className="pb-3 pr-4">Video ID</th>
                      <th className="pb-3 pr-4">Status</th>
                      <th className="pb-3 pr-4">Rank</th>
                      <th className="pb-3 pr-4">Edit</th>
                      <th className="pb-3 text-right">Actions</th>
                    </tr>
                  </thead>
                  <SortableContext items={sortedChannels.map(c => c.id)} strategy={verticalListSortingStrategy}>
                    <tbody>
                      {sortedChannels.map((channel) => {
                        const isEditing = editingChannel?.id === channel.id;
                        const isHidden = channel.isVisible === false;
                        return (
                          <SortableChannelRow key={channel.id} id={channel.id} disabled={isEditing} isHidden={isHidden}>
                            {isEditing ? (
                              <>
                                <td className="py-3 pr-4">
                                  <input
                                    type="text"
                                    value={editingChannel.name}
                                    onChange={(e) => setEditingChannel({ ...editingChannel, name: e.target.value })}
                                    className="w-full px-2 py-1 bg-slate-800 border border-slate-600 rounded text-white text-sm"
                                  />
                                </td>
                                <td className="py-3 pr-4">
                                  <select
                                    value={editingChannel.platform}
                                    onChange={(e) => setEditingChannel({ ...editingChannel, platform: e.target.value })}
                                    className="px-2 py-1 bg-slate-800 border border-slate-600 rounded text-white text-sm"
                                  >
                                    <option value="youtube">YouTube</option>
                                    <option value="twitch">Twitch</option>
                                    <option value="kick">Kick</option>
                                  </select>
                                </td>
                                <td className="py-3 pr-4">
                                  <input
                                    type="text"
                                    value={editingChannel.category || ''}
                                    onChange={(e) => setEditingChannel({ ...editingChannel, category: e.target.value })}
                                    className="w-full px-2 py-1 bg-slate-800 border border-slate-600 rounded text-white text-sm"
                                  />
                                </td>
                                <td className="py-3 pr-4">
                                  <div className="space-y-1">
                                    <input
                                      type="text"
                                      value={editingChannel.videoId || ''}
                                      onChange={(e) => {
                                        // FIXED: Always sanitize video ID on edit
                                        const resolved = smartVideoIdHandler(e.target.value);
                                        setEditingChannel({ ...editingChannel, videoId: resolved, isManualOverride: true });
                                      }}
                                      className="w-full px-2 py-1 bg-slate-800 border border-slate-600 rounded text-white text-sm"
                                      placeholder="Video ID or YouTube URL"
                                    />
                                    <div className="flex gap-1">
                                      <input
                                        type="text"
                                        value={scrapeUrl}
                                        onChange={(e) => setScrapeUrl(e.target.value)}
                                        className="flex-1 px-2 py-1 bg-slate-700 border border-slate-500 rounded text-white text-xs"
                                        placeholder="Paste YouTube URL..."
                                      />
                                      <button
                                        onClick={handleScrapeUrl}
                                        className="px-2 py-1 bg-purple-600 hover:bg-purple-500 rounded text-white text-xs"
                                        title="Extract ID from URL"
                                      >
                                        <LinkIcon className="w-3 h-3" />
                                      </button>
                                    </div>
                                    <input
                                      type="text"
                                      value={editingChannel.logoUrl || ''}
                                      onChange={(e) => setEditingChannel({ ...editingChannel, logoUrl: e.target.value })}
                                      className="w-full px-2 py-1 bg-slate-700 border border-slate-500 rounded text-white text-xs"
                                      placeholder="Channel Logo URL"
                                      data-testid="input-edit-channel-logo"
                                    />
                                    <label className="flex items-center gap-1 text-xs text-slate-400">
                                      <input
                                        type="checkbox"
                                        checked={editingChannel.isManualOverride || false}
                                        onChange={(e) => setEditingChannel({ ...editingChannel, isManualOverride: e.target.checked })}
                                        className="w-3 h-3"
                                      />
                                      Manual Override (locked)
                                    </label>
                                  </div>
                                </td>
                                <td className="py-3 pr-4">
                                  <select
                                    value={editingChannel.isLive ? 'live' : 'offline'}
                                    onChange={(e) => setEditingChannel({ ...editingChannel, isLive: e.target.value === 'live' })}
                                    className="px-2 py-1 bg-slate-800 border border-slate-600 rounded text-white text-sm"
                                  >
                                    <option value="live">Live</option>
                                    <option value="offline">Offline</option>
                                  </select>
                                </td>
                                <td className="py-3 pr-4">
                                  <input
                                    type="number"
                                    value={editingChannel.rank ?? 999}
                                    onChange={(e) => setEditingChannel({ ...editingChannel, rank: parseInt(e.target.value) || 999 })}
                                    className="w-16 px-2 py-1 bg-slate-800 border border-slate-600 rounded text-white text-sm text-center"
                                    min="1"
                                    placeholder="999"
                                  />
                                </td>
                                <td className="py-3 pr-4">
                                  <div className="flex items-center gap-2">
                                    <button
                                      onClick={() => updateMutation.mutate(editingChannel)}
                                      disabled={updateMutation.isPending}
                                      className="p-2 bg-emerald-600 hover:bg-emerald-500 rounded-lg text-white transition-colors"
                                    >
                                      <Save className="w-4 h-4" />
                                    </button>
                                    <button
                                      onClick={() => setEditingChannel(null)}
                                      className="p-2 bg-slate-600 hover:bg-slate-500 rounded-lg text-white transition-colors"
                                    >
                                      <X className="w-4 h-4" />
                                    </button>
                                  </div>
                                </td>
                                <td className="py-3 text-right"></td>
                              </>
                            ) : (
                              <>
                                <td className="py-3 pr-4 text-white font-medium">{channel.name}</td>
                                <td className="py-3 pr-4">
                                  <span className={`px-2 py-1 rounded text-xs ${
                                    channel.platform === 'youtube' ? 'bg-red-500/20 text-red-400' :
                                    channel.platform === 'twitch' ? 'bg-purple-500/20 text-purple-400' :
                                    'bg-green-500/20 text-green-400'
                                  }`}>
                                    {channel.platform}
                                  </span>
                                </td>
                                <td className="py-3 pr-4 text-slate-300">{channel.category || '-'}</td>
                                <td className="py-3 pr-4 text-slate-400 font-mono text-xs">{channel.videoId || '-'}</td>
                                <td className="py-3 pr-4">
                                  <span className={`px-2 py-1 rounded text-xs ${
                                    channel.isLive ? 'bg-emerald-500/20 text-emerald-400' : 'bg-slate-500/20 text-slate-400'
                                  }`}>
                                    {channel.isLive ? 'Live' : 'Offline'}
                                  </span>
                                </td>
                                <td className="py-3 pr-4 text-slate-400 text-center">{channel.rank ?? 999}</td>
                                <td className="py-3 pr-4">
                                  <button
                                    onClick={() => setEditingChannel(channel)}
                                    className="p-2 bg-blue-600 hover:bg-blue-500 rounded-lg text-white transition-colors"
                                    data-testid={`button-edit-${channel.id}`}
                                  >
                                    <Edit2 className="w-4 h-4" />
                                  </button>
                                </td>
                                <td className="py-3 text-right">
                                  {isHidden ? (
                                    <div className="flex items-center gap-2 justify-end">
                                      <button
                                        type="button"
                                        onPointerDown={(e) => {
                                          e.stopPropagation();
                                          handleReveal(channel.id);
                                        }}
                                        disabled={hideMutation.isPending}
                                        className="z-50 relative px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 rounded-lg text-white font-medium text-xs transition-colors disabled:opacity-50"
                                        data-testid={`button-reveal-${channel.id}`}
                                      >
                                        Reveal
                                      </button>
                                      <button
                                        type="button"
                                        onPointerDown={(e) => {
                                          e.stopPropagation();
                                          handlePermanentDelete(channel.id, channel.name);
                                        }}
                                        disabled={deleteMutation.isPending}
                                        className="z-50 relative px-3 py-1.5 bg-red-600 hover:bg-red-500 rounded-lg text-white font-medium text-xs transition-colors disabled:opacity-50"
                                        data-testid={`button-delete-${channel.id}`}
                                      >
                                        Delete
                                      </button>
                                    </div>
                                  ) : (
                                    <button
                                      type="button"
                                      onPointerDown={(e) => {
                                        e.stopPropagation();
                                        if (confirm(`Hide "${channel.name}" from the sidebar?`)) {
                                          handleHide(channel.id);
                                        }
                                      }}
                                      disabled={hideMutation.isPending}
                                      className="z-50 relative px-3 py-1.5 bg-amber-600 hover:bg-amber-500 rounded-lg text-white font-medium text-xs transition-colors disabled:opacity-50"
                                      data-testid={`button-hide-${channel.id}`}
                                    >
                                      Hide
                                    </button>
                                  )}
                                </td>
                              </>
                            )}
                          </SortableChannelRow>
                        );
                      })}
                    </tbody>
                  </SortableContext>
                </table>
              </div>
            </DndContext>
          )}
        </div>

        <div className="mt-8 p-4 bg-slate-800/30 rounded-lg border border-slate-700">
          <p className="text-slate-400 text-sm">
            Logged in as: <span className="text-cyan-400 font-medium">{user?.email}</span>
          </p>
        </div>
      </div>
      </div>
      <Footer />
    </div>
  );
}
