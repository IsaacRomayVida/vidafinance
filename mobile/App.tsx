import {
  DMSans_400Regular,
  DMSans_500Medium,
  DMSans_700Bold,
} from '@expo-google-fonts/dm-sans';
import { DMSerifDisplay_400Regular } from '@expo-google-fonts/dm-serif-display';
import { DefaultTheme, NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useFonts } from 'expo-font';
import { StatusBar } from 'expo-status-bar';
import React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import './src/i18n';
import { BrandIntro } from './src/components/BrandIntro';
import { FunpayMark } from './src/components/FunpayLogo';
import { WebTopBar } from './src/components/WebLayout';
import { AuthProvider, useAuth } from './src/hooks/useAuth';
import { readWebMode, useLayout } from './src/lib/layout';
import { HomeScreen } from './src/screens/HomeScreen';
import { LoansScreen } from './src/screens/LoansScreen';
import { LoginScreen } from './src/screens/LoginScreen';
import { OnboardingScreen } from './src/screens/OnboardingScreen';
import { RequestLoanScreen } from './src/screens/RequestLoanScreen';
import { colors } from './src/theme';
import type { AuthStackParamList, RootStackParamList } from './src/types';

const Stack = createNativeStackNavigator<RootStackParamList>();
const AuthStack = createNativeStackNavigator<AuthStackParamList>();

// Screens own their full canvas (Backdrop + glass headers), so the
// navigator chrome is invisible; the theme only sets the underlying wash.
const navTheme = {
  ...DefaultTheme,
  colors: {
    ...DefaultTheme.colors,
    background: colors.bg,
    card: colors.bg,
    text: colors.text,
    primary: colors.brand,
    border: 'transparent',
  },
};

function Splash() {
  return (
    <View
      style={{
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: colors.bg,
        gap: 24,
      }}
    >
      <FunpayMark size={64} />
      <ActivityIndicator color={colors.brand} />
    </View>
  );
}

function Root() {
  const { user, ready, onboardingHold } = useAuth();

  // Until persistence answers, show the brand splash — never flash the login
  // screen at a signed-in borrower on cold start.
  if (!ready) return <Splash />;

  // The hold keeps the wizard (and its success moment) on screen even after
  // registration has signed the new borrower in mid-flow.
  if (!user || onboardingHold) {
    return (
      <AuthStack.Navigator
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.bg },
          animation: 'fade_from_bottom',
          animationDuration: 220,
        }}
      >
        {/* title → document.title on web: the team portal labels feedback
            with the framed document's title, so every screen names itself. */}
        <AuthStack.Screen name="Login" component={LoginScreen} options={{ title: 'Entrar' }} />
        <AuthStack.Screen
          name="Onboarding"
          component={OnboardingScreen}
          options={{ title: 'Crear cuenta' }}
        />
      </AuthStack.Navigator>
    );
  }

  return (
    <Stack.Navigator
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: colors.bg },
        animation: 'fade_from_bottom',
        animationDuration: 220,
      }}
    >
      <Stack.Screen name="Home" component={HomeScreen} options={{ title: 'Inicio' }} />
      <Stack.Screen name="Loans" component={LoansScreen} options={{ title: 'Mis préstamos' }} />
      <Stack.Screen
        name="RequestLoan"
        component={RequestLoanScreen}
        options={{ title: 'Solicitar préstamo' }}
      />
    </Stack.Navigator>
  );
}

/** Desktop web gets a site-style top bar once signed in; auth screens own
 *  their whole canvas (the Login split has its own brand panel). */
function Shell({ children }: { children: React.ReactNode }) {
  const { isDesktop } = useLayout();
  const { user, onboardingHold } = useAuth();
  if (!isDesktop || !user || onboardingHold) return <>{children}</>;
  return (
    <View style={{ flex: 1 }}>
      <WebTopBar />
      {children}
    </View>
  );
}

export default function App() {
  // The brand's own faces (public-v2 loads the same pair from Google Fonts).
  // Until they're ready, the splash holds — mixed-font flashes read as broken.
  const [fontsLoaded] = useFonts({
    DMSans_400Regular,
    DMSans_500Medium,
    DMSans_700Bold,
    DMSerifDisplay_400Regular,
  });
  // The web frames (`?ui=web`) are a website: content first, no brand film.
  const [introDone, setIntroDone] = React.useState(readWebMode());
  // A font that never arrives (blocked CDN, poisoned cache) must degrade to
  // system type, never hold the product on the splash forever.
  const [fontTimeout, setFontTimeout] = React.useState(false);
  React.useEffect(() => {
    const t = setTimeout(() => setFontTimeout(true), 3000);
    return () => clearTimeout(t);
  }, []);
  if (!fontsLoaded && !fontTimeout) return <Splash />;

  return (
    <SafeAreaProvider>
      <AuthProvider>
        <NavigationContainer theme={navTheme}>
          <StatusBar style="dark" />
          <Shell>
            <Root />
          </Shell>
          {/* Brand moment on cold start, laid over the already-mounted app so
              the handoff is a fade, never a blank frame. */}
          {!introDone ? <BrandIntro onDone={() => setIntroDone(true)} /> : null}
        </NavigationContainer>
      </AuthProvider>
    </SafeAreaProvider>
  );
}
