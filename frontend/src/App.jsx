import { BrowserRouter, Routes, Route } from "react-router-dom";
import { AuthProvider } from "./context/AuthContext";
import Navbar from "./components/Navbar";
import ProtectedRoute from "./components/ProtectedRoute";

import Home from "./pages/Home";
import Login from "./pages/Login";
import Register from "./pages/Register";
import VerifyEmail from "./pages/VerifyEmail";
import ForgotPassword from "./pages/ForgotPassword";
import ResetPassword from "./pages/ResetPassword";
import Marketplace from "./pages/Marketplace";
import ProductDetail from "./pages/ProductDetail";
import SellerProfile from "./pages/SellerProfile";
import Orders from "./pages/Orders";
import Favorites from "./pages/Favorites";
import Listings from "./pages/Listings";
import ListingCreate from "./pages/ListingCreate";
import ListingDetail from "./pages/ListingDetail";
import Rentals from "./pages/Rentals";
import RentalCreate from "./pages/RentalCreate";
import RentalDetail from "./pages/RentalDetail";
import MyRentalBookings from "./pages/MyRentalBookings";
import Events from "./pages/Events";
import EventDetail from "./pages/EventDetail";
import MyTickets from "./pages/MyTickets";
import OrganizerEvents from "./pages/OrganizerEvents";
import OrganizerEventDetail from "./pages/OrganizerEventDetail";
import Merchant from "./pages/Merchant";
import MerchantApply from "./pages/MerchantApply";
import Admin from "./pages/Admin";
import Notifications from "./pages/Notifications";
import ManualPayment from "./pages/ManualPayment";
import PaymentApprovals from "./pages/PaymentApprovals";
import PayoutAccounts from "./pages/PayoutAccounts";
import Profile from "./pages/Profile";
import PublicProfile from "./pages/PublicProfile";
import VerifyCampus from "./pages/VerifyCampus";
import MockCheckout from "./pages/MockCheckout";
import NotFound from "./pages/NotFound";
import Commissions from "./pages/Commissions";
import AdminCommissions from "./pages/AdminCommissions";
import { ADMIN_ROLES } from "./config/roles";

function Layout({ children }) {
  return (
    <div className="min-h-full">
      <Navbar />
      <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Layout>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/login" element={<Login />} />
            <Route path="/register" element={<Register />} />
            <Route path="/verify-email" element={<VerifyEmail />} />
            <Route path="/forgot-password" element={<ForgotPassword />} />
            <Route path="/reset-password" element={<ResetPassword />} />

            <Route path="/marketplace" element={<Marketplace />} />
            <Route path="/marketplace/:id" element={<ProductDetail />} />
            <Route path="/seller/:id" element={<SellerProfile />} />
            <Route path="/orders" element={<ProtectedRoute role={["student", ...ADMIN_ROLES]}><Orders /></ProtectedRoute>} />
            <Route path="/favorites" element={<ProtectedRoute><Favorites /></ProtectedRoute>} />

            <Route path="/listings" element={<Listings />} />
            <Route path="/listings/new" element={<ProtectedRoute role="student"><ListingCreate /></ProtectedRoute>} />
            <Route path="/listings/:id" element={<ListingDetail />} />

            <Route path="/rentals" element={<Rentals />} />
            <Route path="/rentals/new" element={<ProtectedRoute><RentalCreate /></ProtectedRoute>} />
            <Route path="/rentals/mine" element={<ProtectedRoute><MyRentalBookings /></ProtectedRoute>} />
            <Route path="/rentals/:id" element={<RentalDetail />} />

            <Route path="/events" element={<Events />} />
            <Route path="/events/:id" element={<EventDetail />} />
            <Route path="/tickets" element={<ProtectedRoute role={["student", ...ADMIN_ROLES]}><MyTickets /></ProtectedRoute>} />

            <Route path="/organizer" element={<ProtectedRoute role={["organizer", ...ADMIN_ROLES]}><OrganizerEvents /></ProtectedRoute>} />
            <Route path="/organizer/:id" element={<ProtectedRoute role={["organizer", ...ADMIN_ROLES]}><OrganizerEventDetail /></ProtectedRoute>} />

            <Route path="/merchant-apply" element={<ProtectedRoute role="student"><MerchantApply /></ProtectedRoute>} />
            <Route path="/merchant" element={<ProtectedRoute role={["merchant", ...ADMIN_ROLES]}><Merchant /></ProtectedRoute>} />

            <Route path="/admin" element={<ProtectedRoute role={ADMIN_ROLES}><Admin /></ProtectedRoute>} />

            <Route path="/notifications" element={<ProtectedRoute><Notifications /></ProtectedRoute>} />
            <Route path="/profile" element={<ProtectedRoute><Profile /></ProtectedRoute>} />
            <Route path="/profile/:id" element={<PublicProfile />} />
            <Route path="/verify" element={<ProtectedRoute><VerifyCampus /></ProtectedRoute>} />

            <Route path="/pay/manual/:paymentId" element={<ProtectedRoute><ManualPayment /></ProtectedRoute>} />
            <Route path="/payment-approvals" element={<ProtectedRoute><PaymentApprovals /></ProtectedRoute>} />
            <Route path="/commissions" element={<ProtectedRoute><Commissions /></ProtectedRoute>} />
            <Route path="/admin/commissions" element={<ProtectedRoute role={ADMIN_ROLES}><AdminCommissions /></ProtectedRoute>} />
            <Route path="/payout-accounts" element={<ProtectedRoute><PayoutAccounts /></ProtectedRoute>} />

            <Route path="/mock-checkout/:paymentId" element={<ProtectedRoute><MockCheckout /></ProtectedRoute>} />

            <Route path="*" element={<NotFound />} />
          </Routes>
        </Layout>
      </AuthProvider>
    </BrowserRouter>
  );
}