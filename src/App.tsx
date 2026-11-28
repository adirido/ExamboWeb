import { useEffect, useState } from 'react';
import { TeacherLogin } from './components/TeacherLogin';
import { TeacherDashboard } from './components/TeacherDashboard';
import { StudentExamPortal } from './components/StudentExamPortal';
import type { StudentExamRouteParams, TeacherProfile } from './types';

function parseRouteFromLocation(): {
  mode: 'teacher' | 'student';
  studentParams: StudentExamRouteParams;
} {
  const rawHash = window.location.hash || '';
  const withoutHash = rawHash.startsWith('#') ? rawHash.slice(1) : rawHash;
  const [rawPath, rawHashQuery = ''] = withoutHash.split('?');
  const normalizedPath = rawPath.replace(/^\/+/, '').toLowerCase();

  const searchParams = new URLSearchParams(window.location.search);
  const hashParams = new URLSearchParams(rawHashQuery);

  const rawToken = hashParams.get('token') ?? searchParams.get('token') ?? '';
  const rawNis = hashParams.get('nis') ?? searchParams.get('nis') ?? '';
  const rawPin = hashParams.get('pin') ?? searchParams.get('pin') ?? '';
  const rawSim = hashParams.get('sim') ?? searchParams.get('sim') ?? '';

  const token = rawToken.trim().toUpperCase() || undefined;
  const nis = rawNis.trim() || undefined;
  const pin = rawPin.trim() || undefined;
  const isSimulator = rawSim === '1' || rawSim.toLowerCase() === 'true';

  const isStudentRoute =
    normalizedPath === 'exam' ||
    normalizedPath.startsWith('exam/') ||
    Boolean(token);

  return {
    mode: isStudentRoute ? 'student' : 'teacher',
    studentParams: {
      token,
      nis,
      pin,
      hasExplicitParams: Boolean(token || nis || pin),
      isSimulator,
    },
  };
}

const TEACHER_SESSION_KEY = 'examflow_teacher_session';

function readStoredTeacherSession(): { token: string; profile: TeacherProfile } | null {
  try {
    const raw = window.sessionStorage.getItem(TEACHER_SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { token?: unknown; profile?: TeacherProfile };
    if (
      typeof parsed?.token === 'string' &&
      parsed.token.length > 0 &&
      parsed.profile &&
      typeof parsed.profile.id === 'number' &&
      typeof parsed.profile.email === 'string'
    ) {
      return { token: parsed.token, profile: parsed.profile };
    }
    return null;
  } catch {
    return null;
  }
}

export default function App() {
  const [routeState, setRouteState] = useState(() => parseRouteFromLocation());
  const [initialSession] = useState(() => readStoredTeacherSession());
  const [teacherToken, setTeacherToken] = useState<string | null>(() => initialSession?.token ?? null);
  const [teacherProfile, setTeacherProfile] = useState<TeacherProfile | null>(() => initialSession?.profile ?? null);

  useEffect(() => {
    function handleHashChange() {
      setRouteState(parseRouteFromLocation());
    }
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  function openStudentPortal(simulator = false) {
    window.location.hash = simulator ? '#/exam?sim=1' : '#/exam';
    setRouteState(parseRouteFromLocation());
  }

  function openTeacherPortal() {
    if (window.location.search) {
      window.history.replaceState(null, '', window.location.pathname);
    }
    window.location.hash = '';
    setRouteState(parseRouteFromLocation());
  }

  function handleTeacherLogin(token: string, profile: TeacherProfile) {
    try {
      window.sessionStorage.setItem(TEACHER_SESSION_KEY, JSON.stringify({ token, profile }));
    } catch {
      // Ignore storage quota errors
    }
    setTeacherToken(token);
    setTeacherProfile(profile);
  }

  function handleTeacherLogout() {
    try {
      window.sessionStorage.removeItem(TEACHER_SESSION_KEY);
    } catch {
      // Ignore storage access errors
    }
    setTeacherToken(null);
    setTeacherProfile(null);
  }

  if (routeState.mode === 'student') {
    return (
      <StudentExamPortal
        routeParams={routeState.studentParams}
        onBackToTeacher={openTeacherPortal}
      />
    );
  }

  if (!teacherToken || !teacherProfile) {
    return (
      <TeacherLogin
        onSuccess={handleTeacherLogin}
        onOpenStudentPortal={() => openStudentPortal(false)}
      />
    );
  }

  return (
    <TeacherDashboard
      token={teacherToken}
      teacher={teacherProfile}
      onLogout={handleTeacherLogout}
      onOpenStudentPortal={() => openStudentPortal(true)}
    />
  );
}
