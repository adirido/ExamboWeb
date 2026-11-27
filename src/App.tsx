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

  const token = rawToken.trim().toUpperCase() || undefined;
  const nis = rawNis.trim() || undefined;
  const pin = rawPin.trim() || undefined;

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
    },
  };
}

export default function App() {
  const [routeState, setRouteState] = useState(() => parseRouteFromLocation());
  // Keep teacher auth token strictly in React memory (never localStorage/sessionStorage)
  const [teacherToken, setTeacherToken] = useState<string | null>(null);
  const [teacherProfile, setTeacherProfile] = useState<TeacherProfile | null>(null);

  useEffect(() => {
    function handleHashChange() {
      setRouteState(parseRouteFromLocation());
    }
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  function openStudentPortal() {
    window.location.hash = '#/exam';
    setRouteState(parseRouteFromLocation());
  }

  function openTeacherPortal() {
    if (window.location.search) {
      window.history.replaceState(null, '', window.location.pathname);
    }
    window.location.hash = '';
    setRouteState(parseRouteFromLocation());
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
        onSuccess={(token, profile) => {
          setTeacherToken(token);
          setTeacherProfile(profile);
        }}
        onOpenStudentPortal={openStudentPortal}
      />
    );
  }

  return (
    <TeacherDashboard
      token={teacherToken}
      teacher={teacherProfile}
      onLogout={() => {
        setTeacherToken(null);
        setTeacherProfile(null);
      }}
      onOpenStudentPortal={openStudentPortal}
    />
  );
}
