export type RootStackParamList = {
  Home: undefined;
  Loans: { filter?: 'all' | 'active' | 'paid' } | undefined;
  RequestLoan: undefined;
};

export type AuthStackParamList = {
  Login: undefined;
  Onboarding: undefined;
};
