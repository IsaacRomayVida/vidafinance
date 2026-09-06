import {
  DMSans_400Regular,
  DMSans_500Medium,
  DMSans_700Bold,
} from '@expo-google-fonts/dm-sans';
import { DMSerifDisplay_400Regular } from '@expo-google-fonts/dm-serif-display';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useFonts } from 'expo-font';
import { StatusBar } from 'expo-status-bar';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, View } from 'react-native';

import './src/i18n';
import { FunpayMark } from './src/components/FunpayLogo';
import { AuthProvider, useAuth } from './src/hooks/useAuth';
import { HomeScreen } from './src/screens/HomeScreen';
import { LoansScreen } from './src/screens/LoansScreen';
import { LoginScreen } from './src/screens/LoginScreen';
import { RequestLoanScreen } from './src/screens/RequestLoanScreen';
import { colors, fonts } from './src/theme';
import type { RootStackParamList } from './src/types';

const Stack = createNativeStackNavigator<RootStackParamList>();

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
  const { t } = useTranslation();
  const { user, ready } = useAuth();

  // Until persistence answers, show the brand splash — never flash the login
  // screen at a signed-in borrower on cold start.
  if (!ready) return <Splash />;

  if (!user) return <LoginScreen />;

  return (
    <Stack.Navigator
      screenOptions={{
        headerShadowVisible: false,
        headerStyle: { backgroundColor: colors.bg },
        headerTintColor: colors.brand,
        headerTitleStyle: { fontFamily: fonts.sansBold, fontSize: 17, color: colors.text },
        headerBackButtonDisplayMode: 'minimal',
        contentStyle: { backgroundColor: colors.bg },
      }}
    >
      <Stack.Screen
        name="Home"
        component={HomeScreen}
        options={{
          title: t('common.appName'),
          headerTitle: () => (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <FunpayMark size={28} />
            </View>
          ),
        }}
      />
      <Stack.Screen name="Loans" component={LoansScreen} options={{ title: t('loans.title') }} />
      <Stack.Screen
        name="RequestLoan"
        component={RequestLoanScreen}
        options={{ title: t('request.title') }}
      />
    </Stack.Navigator>
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
  if (!fontsLoaded) return <Splash />;

  return (
    <AuthProvider>
      <NavigationContainer>
        <StatusBar style="dark" />
        <Root />
      </NavigationContainer>
    </AuthProvider>
  );
}
